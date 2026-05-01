import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface JWTPayload {
  id: string;
  username: string;
  tier: number;
  scope: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
      userTier?: number;
    }
  }
}

export const protectTier = (requiredTier: number) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.header('Authorization');
    const token = authHeader ? authHeader.replace('Bearer ', '') : req.header('x-auth-token');

    if (!token) {
      res.status(401).json({ message: "No token, access denied." });
      return;
    }

    try {
      const secret = process.env['JWT_SECRET'];
      if (!secret) {
        res.status(500).json({ message: "Server configuration error." });
        return;
      }
      const decoded = jwt.verify(token, secret) as JWTPayload;
      req.user = decoded;
      req.userTier = decoded.tier;

      if (decoded.tier < requiredTier) {
        res.status(403).json({
          message: `Access Denied: Requires Tier ${requiredTier}. Your Tier: ${decoded.tier}`
        });
        return;
      }
      next();
    } catch {
      res.status(401).json({ message: "Token is not valid or expired." });
    }
  };
};
