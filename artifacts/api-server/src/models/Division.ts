import mongoose, { Schema, type Document } from 'mongoose';

export interface ISubUnit {
  name: string;
  groupId: number;
}

export interface IDivision extends Document {
  name: string;
  subUnits: ISubUnit[];
  createdAt: Date;
}

const DivisionSchema = new Schema<IDivision>({
  name: { type: String, required: true, unique: true },
  subUnits: [{
    name: { type: String, required: true },
    groupId: { type: Number, required: true }
  }],
  createdAt: { type: Date, default: Date.now }
});

export const Division = mongoose.model<IDivision>('Division', DivisionSchema);
