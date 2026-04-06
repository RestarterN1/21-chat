import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  channelId: { type: String, required: true, enum: ['general', 'random', 'tech', 'agile'] },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true },
  authorAvatar: { type: String, default: '' },
  text: { type: String, default: '' },
  image: { type: String, default: null }, // base64 или URL
  edited: { type: Boolean, default: false },
  editedAt: { type: Date },
  timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

export const Message = mongoose.model('Message', messageSchema);