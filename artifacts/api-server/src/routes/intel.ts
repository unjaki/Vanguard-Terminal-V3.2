import { Router } from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import { protectTier } from '../middlewares/auth.js';
import { rbxApi, fetchWithRetry, requestWithRetry, fetchOutfitThumbnails } from '../lib/roblox.js';
import { logAction } from '../lib/audit.js';
import { Division } from '../models/Division.js';

const router = Router();
const groupCache = new Map<string, { timestamp: number; data: unknown }>();
const intelCache = new Map<string, { timestamp: number; data: unknown }>();
const CACHE_TTL = 300000; // 5 minutes
const NS_GROUP_ID = "1008942731";

// --- GROUP INFO ---
router.get('/group-info/:groupId', protectTier(2), async (req, res) => {
  const { groupId } = req.params;

  if (!groupId || !/^\d+$/.test(groupId)) {
    res.status(400).json({ error: 'Invalid Group ID', details: 'Numeric ID required.' });
    return;
  }

  const cached = groupCache.get(groupId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    res.json(cached.data);
    return;
  }

  try {
    const groupRes = await fetchWithRetry(rbxApi('groups', `/v1/groups/${groupId}`));
    const data = groupRes.data as {
      name: string; memberCount: number; description: string;
      owner?: { username: string; userId: number };
      shout?: { body: string };
    };

    const rolesRes = await fetchWithRetry(rbxApi('groups', `/v1/groups/${groupId}/roles`));
    const roles = ((rolesRes.data as { roles: { name: string; rank: number; memberCount: number }[] }).roles)
      .sort((a, b) => b.rank - a.rank);

    const result = {
      name: data.name,
      memberCount: data.memberCount,
      description: data.description,
      owner: data.owner ? { username: data.owner.username, userId: data.owner.userId } : { username: "None", userId: 0 },
      shout: data.shout ? data.shout.body : null,
      roles: roles.map(r => ({ name: r.name, rank: r.rank, memberCount: r.memberCount }))
    };

    logAction(req.user!, "UNIT_INTEL_LOOKUP", `**Target Unit:** ${data.name}\n**ID:** ${groupId}`);
    groupCache.set(groupId, { timestamp: Date.now(), data: result });
    res.json(result);
  } catch (error: unknown) {
    const err = error as { response?: { status?: number }; message?: string };
    if (err.response?.status === 429) {
      res.status(429).json({ error: 'Uplink Congested', message: 'Roblox is limiting requests. Try again in a few minutes.' });
      return;
    }
    res.status(500).json({ error: 'Failed to fetch unit data', message: err.message });
  }
});

// --- VERIFY MEMBER ---
router.get('/verify-member/:unitName/:username', protectTier(2), async (req, res) => {
  try {
    const { unitName, username } = req.params;

    // 1. Roblox resolution
    let userData: { id: number; name: string } | undefined;
    try {
      const exactRes = await requestWithRetry(rbxApi('users', '/v1/usernames/users'), {
        method: 'POST',
        data: { usernames: [username.trim()], excludeBannedUsers: false },
        timeout: 5000
      });
      userData = (exactRes.data as { data: { id: number; name: string }[] }).data[0];

      if (!userData) {
        const searchRes = await fetchWithRetry(rbxApi('users', `/v1/users/search?keyword=${encodeURIComponent(username.trim())}&limit=1`), { timeout: 5000 });
        userData = (searchRes.data as { data: { id: number; name: string }[] }).data[0];
      }
    } catch (rbErr: unknown) {
      const e = rbErr as { response?: { status?: number }; message?: string };
      if (e.response?.status === 429) { res.status(429).json({ message: "Uplink Congested" }); return; }
      res.status(500).json({ message: "Uplink Error" });
      return;
    }

    if (!userData) { res.status(404).json({ message: "User Not Found" }); return; }

    // 2. Find target unit
    let unit: { name: string; groupId: number } | null = null;
    try {
      const division = await Division.findOne({ "subUnits.name": unitName });
      const subUnit = division?.subUnits.find(u => u.name === unitName);
      if (subUnit) unit = { name: subUnit.name, groupId: subUnit.groupId };
      if (!unit && /^\d+$/.test(unitName)) unit = { name: "Direct Uplink", groupId: parseInt(unitName) };
    } catch (dbErr: unknown) {
      const e = dbErr as { message?: string };
      console.error(`[SCAN] Database Error: ${e.message}`);
    }

    if (!unit) { res.status(404).json({ message: "Unit Not Configured" }); return; }

    const rbId = userData.id;
    const robloxUsername = userData.name;
    logAction(req.user!, "PERSONNEL_SCAN", `**Subject:** ${robloxUsername}\n**Unit:** ${unitName}\n**ID:** ${rbId}`);

    // 3. Rank check
    let groupData: { role: { name: string; rank: number } } | undefined;
    let nsGroupData: { role: { name: string; rank: number } } | undefined;
    let subDivisions: { name: string; rank: string; rankId: number }[] = [];

    try {
      const rbRes = await fetchWithRetry(rbxApi('groups', `/v1/users/${rbId}/groups/roles`));
      const groups = (rbRes.data as { data: { group: { id: number }; role: { name: string; rank: number } }[] }).data;

      groupData = groups.find(g => g.group.id == unit!.groupId);
      nsGroupData = groups.find(g => String(g.group.id) === NS_GROUP_ID);

      const allDivs = await Division.find({});
      const subUnitList = allDivs.flatMap(d => d.subUnits);

      groups.forEach(g => {
        const matchedSub = subUnitList.find(s => s.groupId == g.group.id);
        if (matchedSub) subDivisions.push({ name: matchedSub.name, rank: g.role.name, rankId: g.role.rank });
      });
    } catch (roleErr: unknown) {
      const e = roleErr as { message?: string };
      console.error(`[SCAN] Roblox Roles API Error: ${e.message}`);
    }

    // 4. RoWifi verification
    let discordInfo = "Not Linked";
    try {
      const guildId = process.env['DISCORD_GUILD_ID'];
      const apiKey = (process.env['ROWIFI_API_KEY'] || "").trim();

      if (guildId && apiKey) {
        const reverseRes = await axios.get(
          `https://api.rowifi.xyz/v3/guilds/${guildId}/members/roblox/${rbId}`,
          { headers: { 'Authorization': `Bot ${apiKey}` } }
        );
        const data = reverseRes.data;
        let candidates: string[] = [];

        if (Array.isArray(data)) {
          candidates = data.map(x => (typeof x === 'object' ? String((x as { discord_id: string }).discord_id) : String(x)));
        } else if (data && (data as { discord_ids?: unknown[] }).discord_ids) {
          candidates = ((data as { discord_ids: unknown[] }).discord_ids).map(String);
        }

        for (const did of candidates) {
          try {
            const memberRes = await axios.get(
              `https://api.rowifi.xyz/v3/guilds/${guildId}/members/${did}`,
              { headers: { 'Authorization': `Bot ${apiKey}` } }
            );
            if (String((memberRes.data as { roblox_id?: number })?.roblox_id) === String(rbId)) {
              discordInfo = did;
              break;
            }
          } catch { continue; }
        }
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number }; message?: string };
      if (e.response?.status !== 404) console.error(`❌ RoWifi Error: ${e.message}`);
    }

    // 5. Status determination
    let officerStatus = "Enlisted";
    if (groupData) {
      const rankId = groupData.role.rank;
      if (rankId >= 218) officerStatus = "CO";
      else if (rankId >= 213) officerStatus = "NCO";
    }
    let nsStatus = "Enlisted";
    if (nsGroupData) {
      const rankId = nsGroupData.role.rank;
      if (rankId >= 202) nsStatus = "CO";
      else if (rankId >= 9) nsStatus = "NCO";
    }

    res.json({
      officer: robloxUsername,
      robloxId: rbId,
      discordId: discordInfo,
      unit: unitName,
      rank: groupData ? groupData.role.name : "UNASSIGNED",
      rankId: groupData ? groupData.role.rank : 0,
      nsRank: nsGroupData ? nsGroupData.role.name : "—",
      status: officerStatus,
      nsStatus,
      subDivisions
    });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("Route Error:", e.message);
    res.status(500).json({ error: "Internal System Error: " + e.message });
  }
});

// --- DEEP INTEL ---
router.get('/deep-intel/:username', protectTier(2), async (req, res) => {
  try {
    const { username } = req.params;
    const force = req.query['force'] === 'true';

    if (!force && intelCache.has(username.toLowerCase())) {
      const cached = intelCache.get(username.toLowerCase())!;
      if (Date.now() - cached.timestamp < CACHE_TTL) { res.json(cached.data); return; }
    }

    const exactRes = await requestWithRetry(rbxApi('users', '/v1/usernames/users'), {
      method: 'POST',
      data: { usernames: [username.trim()], excludeBannedUsers: false }
    });
    const userData = (exactRes.data as { data: { id: number; name: string }[] }).data[0];
    if (!userData) { res.status(404).json({ message: "User not found" }); return; }

    const userId = userData.id;

    const staggeredFetch = async (url: string, delay = 0) => {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url);
    };

    const [groupsRes, avatarRes, bustRes, badgesRes, detailedRes, outfitRes, rotectorRes] = await Promise.all([
      staggeredFetch(rbxApi('groups', `/v1/users/${userId}/groups/roles`), 0).catch(() => ({ data: { data: [] } })),
      staggeredFetch(rbxApi('thumbnails', `/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`), 200).catch(() => ({ data: { data: [{ imageUrl: "" }] } })),
      staggeredFetch(rbxApi('thumbnails', `/v1/users/avatar-bust?userIds=${userId}&size=150x150&format=Png&isCircular=false`), 400).catch(() => ({ data: { data: [{ imageUrl: "" }] } })),
      staggeredFetch(rbxApi('badges', `/v1/users/${userId}/badges?limit=25&sortOrder=Desc`), 600).catch(() => ({ data: { data: [] } })),
      staggeredFetch(rbxApi('users', `/v1/users/${userId}`), 800).catch(() => ({ data: {} })),
      fetchWithRetry(rbxApi('avatar', `/v1/users/${userId}/outfits?isEditable=true&itemsPerPage=50`), {}, 4, 3000).catch(() => ({ data: { data: [] } })),
      fetchWithRetry(`https://roscoe.rotector.com/v1/users/${userId}`, {
        headers: process.env['ROTECTOR_API_KEY'] ? { 'Authorization': `Bearer ${process.env['ROTECTOR_API_KEY']}` } : {}
      }).catch(e => {
        if ((e as { response?: { status?: number } }).response?.status === 404) return { data: null };
        return { data: null };
      })
    ]);

    type GroupEntry = { group: { id: number; name: string }; role: { name: string; rank: number } };
    type BadgeEntry = { id: number; name: string; description: string };
    type OutfitEntry = { id: number; name: string };
    type ThumbEntry = { targetId: number; state: string; imageUrl: string };

    const groups = (groupsRes.data as { data: GroupEntry[] }).data || [];
    const badges = ((badgesRes.data as { data: BadgeEntry[] }).data || []).slice(0, 24);
    const avatar = (avatarRes.data as { data: { imageUrl: string }[] }).data?.[0]?.imageUrl || "";
    const bust = (bustRes.data as { data: { imageUrl: string }[] }).data?.[0]?.imageUrl || "";
    const userDetails = detailedRes.data as { created?: string; description?: string; isBanned?: boolean; displayName?: string };
    const rawOutfits = (outfitRes.data as { data: OutfitEntry[] }).data || [];
    const rotector = (rotectorRes as { data: unknown }).data;

    // Fetch icons
    let groupIcons: Record<number, string> = {};
    let badgeIcons: Record<number, string> = {};
    try {
      const groupIds = groups.map(g => g.group?.id).filter(Boolean).slice(0, 100).join(',');
      const badgeIds = badges.map(b => b.id).filter(Boolean).slice(0, 50).join(',');
      await Promise.allSettled([
        groupIds ? fetchWithRetry(rbxApi('thumbnails', `/v1/groups/icons?groupIds=${groupIds}&size=150x150&format=Png&isCircular=false`))
          .then(r => { (r.data as { data: ThumbEntry[] }).data?.forEach(i => { groupIcons[i.targetId] = i.imageUrl; }); }) : Promise.resolve(),
        badgeIds ? fetchWithRetry(rbxApi('thumbnails', `/v1/badges/icons?badgeIds=${badgeIds}&size=150x150&format=Png&isCircular=false`))
          .then(r => { (r.data as { data: ThumbEntry[] }).data?.forEach(i => { badgeIcons[i.targetId] = i.imageUrl; }); }) : Promise.resolve()
      ]);
    } catch { /* icons are non-critical */ }

    // Outfits — fetch up to 50, get thumbnails in batches with retry
    const FALLBACK_IMG = "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png";
    let outfits: { id: number; name: string; thumbnail: string }[] = [];
    let finalOutfits = rawOutfits;

    // Fallback: try the non-editable endpoint if first fetch was empty
    if (!finalOutfits.length) {
      try {
        const fb = await fetchWithRetry(rbxApi('avatar', `/v1/users/${userId}/outfits?itemsPerPage=50`), { timeout: 8000 });
        finalOutfits = (fb.data as { data: OutfitEntry[] }).data || [];
      } catch { /* non-critical */ }
    }

    if (finalOutfits.length > 0) {
      const filteredOutfits = finalOutfits.slice(0, 50);
      const outfitIds = filteredOutfits.map(o => o.id);
      try {
        const thumbMap = await fetchOutfitThumbnails(outfitIds);
        outfits = filteredOutfits.map(o => ({
          id: o.id,
          name: o.name || "UNNAMED OUTFIT",
          thumbnail: thumbMap.get(o.id) ?? FALLBACK_IMG
        }));
      } catch {
        outfits = filteredOutfits.map(o => ({ id: o.id, name: o.name || "UNNAMED OUTFIT", thumbnail: FALLBACK_IMG }));
      }
    }

    const condoKeywords = ["condo", "inappropriate", "banned", "blacklisted"];
    const isCondo = badges.some(b => condoKeywords.some(kw => b.name.toLowerCase().includes(kw) || b.description.toLowerCase().includes(kw)));

    const rotData = rotector as { data?: { risk_level?: string; flags?: unknown[]; dangerous_groups?: string[]; dangerous_friends?: string[] } } | null;
    const rotRisk = rotData?.data?.risk_level || "Unknown";
    logAction(req.user!, "DEEP_INTEL_SCRAPE", `**Subject:** ${userData.name}\n**ID:** ${userId}\n**Risk Level:** ${isCondo || rotRisk === 'High' ? "CRITICAL" : rotRisk}`);

    const responseData = {
      username: userData.name,
      displayName: userDetails.displayName,
      userId,
      created: userDetails.created,
      description: userDetails.description,
      isBanned: userDetails.isBanned,
      avatar,
      bust,
      outfits,
      groups: groups.map(g => ({
        id: g.group.id, name: g.group.name, rank: g.role.name, rankId: g.role.rank, icon: groupIcons[g.group.id] || ""
      })),
      badges: badges.map(b => ({ name: b.name, icon: badgeIcons[b.id] || "" })),
      isCondoUser: isCondo,
      rotector: rotData?.data || null
    };

    intelCache.set(username.toLowerCase(), { timestamp: Date.now(), data: responseData });
    res.json(responseData);
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("Deep Intel Error:", e.message);
    res.status(500).json({ message: "Uplink Failed" });
  }
});

export default router;
