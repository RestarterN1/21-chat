import express from 'express';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Получить сообщения канала (последние 100)
router.get('/:channelId', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const messages = await Message.find({ channelId })
      .sort({ timestamp: 1 })
      .limit(100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Отправить сообщение
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { channelId, text, image } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

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
    // Популируем authorId для полной информации (опционально)
    const populated = await Message.findById(message._id).populate('authorId', 'username avatar');
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Редактировать сообщение
router.put('/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { text, image } = req.body;
    const message = await Message.findOne({ _id: messageId, authorId: req.user.id });
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено или нет прав' });
    message.text = text !== undefined ? text : message.text;
    if (image !== undefined) message.image = image;
    message.edited = true;
    message.editedAt = new Date();
    await message.save();
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удалить сообщение
router.delete('/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const result = await Message.deleteOne({ _id: messageId, authorId: req.user.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Сообщение не найдено или нет прав' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;