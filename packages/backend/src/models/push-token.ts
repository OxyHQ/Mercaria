import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IPushToken extends Document {
  oxyUserId: string;
  token: string;
  deviceId?: string;
  platform?: 'ios' | 'android' | 'web';
  active: boolean;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PushTokenSchema = new Schema<IPushToken>(
  {
    // Oxy users are EXTERNAL (no local `User` collection) — stored as a String.
    oxyUserId: {
      type: String,
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
    },
    deviceId: {
      type: String,
    },
    platform: {
      type: String,
      enum: ['ios', 'android', 'web'],
    },
    active: {
      type: Boolean,
      default: true,
    },
    lastUsedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

// Each token should be unique per user (upsert-friendly)
PushTokenSchema.index({ oxyUserId: 1, token: 1 }, { unique: true });
// Quick lookup by token for receipt error handling (e.g., DeviceNotRegistered)
PushTokenSchema.index({ token: 1 });

export const PushToken: Model<IPushToken> =
  mongoose.models.PushToken || mongoose.model<IPushToken>('PushToken', PushTokenSchema);
