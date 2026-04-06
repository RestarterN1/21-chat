import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  avatar: { type: String, default: '' }, // base64 или инициалы
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

userSchema.methods.comparePassword = function(password) {
  return bcrypt.compare(password, this.passwordHash);
};

export const User = mongoose.model('User', userSchema);