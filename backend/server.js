import express from 'express';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import messageRoutes from './routes/messages.js';
import { authenticateToken } from './middleware/auth.js';
import { Message } from './models/Message.js';
import { User } from './models/User.js';
import jwt from 'jsonwebtoken';

dotenv.config();
const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // для base64 изображений

// Подключение к MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);

// Socket.IO – реальное время
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    socket.username = decoded.username;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', async (socket) => {
  console.log(`User ${socket.username} connected`);

  // Обновляем статус online
  await User.findByIdAndUpdate(socket.userId, { online: true, lastSeen: new Date() });
  io.emit('user_status', { userId: socket.userId, online: true });

  // Присоединяемся к комнате канала
  socket.on('join_channel', (channelId) => {
    socket.join(channelId);
    console.log(`${socket.username} joined ${channelId}`);
  });

  // Новое сообщение
  socket.on('send_message', async (data) => {
    try {
      const { channelId, text, image } = data;
      const user = await User.findById(socket.userId);
      const message = new Message({
        channelId,
        authorId: user._id,
        authorName: user.username,
        authorAvatar: user.avatar,
        text: text || '',
        image: image || null,
        timestamp: new Date()
      });
      await message.save();
      const populated = await Message.findById(message._id).populate('authorId', 'username avatar');
      io.to(channelId).emit('new_message', populated);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // Редактирование
  socket.on('edit_message', async ({ messageId, text, image }) => {
    const message = await Message.findOne({ _id: messageId, authorId: socket.userId });
    if (message) {
      message.text = text !== undefined ? text : message.text;
      if (image !== undefined) message.image = image;
      message.edited = true;
      message.editedAt = new Date();
      await message.save();
      io.to(message.channelId).emit('message_updated', message);
    }
  });

  // Удаление
  socket.on('delete_message', async ({ messageId }) => {
    const message = await Message.findOne({ _id: messageId, authorId: socket.userId });
    if (message) {
      await Message.deleteOne({ _id: messageId });
      io.to(message.channelId).emit('message_deleted', messageId);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`User ${socket.username} disconnected`);
    await User.findByIdAndUpdate(socket.userId, { online: false, lastSeen: new Date() });
    io.emit('user_status', { userId: socket.userId, online: false });
  });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});