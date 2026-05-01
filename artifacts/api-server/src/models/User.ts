import mongoose, { Schema, type Document } from 'mongoose';

export interface IUser extends Document {
  username: string;
  password: string;
  tier: number;
  division: string;
  unitScope: string;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  tier: { type: Number, default: 1 },
  division: { type: String, default: 'None' },
  unitScope: { type: String, default: 'General' },
  createdAt: { type: Date, default: Date.now }
});

export const User = mongoose.model<IUser>('User', UserSchema);
