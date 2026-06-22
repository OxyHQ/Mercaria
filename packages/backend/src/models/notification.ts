import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Every supported notification type. Declared ONCE as a const tuple so the
 * `NotificationType` union and the schema `enum` cannot drift apart.
 */
export const NOTIFICATION_TYPES = [
  'trigger_result',
  'proactive_insight',
  'daily_briefing',
  'price_alert',
  'integration_event',
  'reminder',
  'agent_task_complete',
  'chat_response_ready',
  'oxy_service',
  // Marketplace (order lifecycle + reviews + store).
  'order_placed',
  'order_paid',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'listing_sold',
  'review_received',
  'store_member_invited',
  'low_inventory',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationChannel = 'push' | 'telegram' | 'discord' | 'whatsapp' | 'slack' | 'in_app';
export type NotificationStatus = 'pending' | 'sent' | 'read' | 'dismissed';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface INotification extends Document {
  oxyUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
  channels: NotificationChannel[];
  deliveryStatus: Record<string, 'pending' | 'sent' | 'failed'>;
  status: NotificationStatus;
  priority: NotificationPriority;
  triggerId?: mongoose.Types.ObjectId;
  conversationId?: string;
  expiresAt?: Date;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>({
  // Oxy users are EXTERNAL (no local `User` collection). Stored as a String
  // (the ecosystem convention) — never coerced to an ObjectId. NO inline index:
  // it is the leading field of the compound indexes below (prefix-covered).
  oxyUserId: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: NOTIFICATION_TYPES as unknown as string[],
  },
  title: { type: String, required: true },
  body: { type: String, required: true },
  data: { type: Schema.Types.Mixed },
  channels: [{
    type: String,
    enum: ['push', 'telegram', 'discord', 'whatsapp', 'slack', 'in_app'],
  }],
  deliveryStatus: { type: Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['pending', 'sent', 'read', 'dismissed'],
    default: 'pending',
  },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal',
  },
  triggerId: { type: Schema.Types.ObjectId, ref: 'Trigger' },
  conversationId: { type: String },
  expiresAt: { type: Date },
  readAt: { type: Date },
}, {
  timestamps: true,
});

// Query by user + status for notification feed
NotificationSchema.index({ oxyUserId: 1, status: 1, createdAt: -1 });
// Unread-count + unread-feed query: a PARTIAL index covering only the unread
// states (`pending`/`sent`), serving `getUnreadCount` / `markAllAsRead`.
const UNREAD_INDEX_OPTIONS: mongoose.IndexOptions = {
  partialFilterExpression: { status: { $in: ['pending', 'sent'] } },
};
NotificationSchema.index({ oxyUserId: 1, createdAt: -1 }, UNREAD_INDEX_OPTIONS);
// TTL: auto-delete dismissed/expired notifications after 90 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { status: 'dismissed' } });

export const Notification: Model<INotification> = mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);
