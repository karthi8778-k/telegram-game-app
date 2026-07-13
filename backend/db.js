// Simple JSON-file based storage for user points.
// NOTE: This is fine for testing / low traffic. For production with many
// concurrent users, replace this with a real database (MongoDB/PostgreSQL)
// to avoid file-write race conditions.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'points.json');

function load() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8') || '{}');
  } catch (e) {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function initUser(userId, name) {
  const data = load();
  if (!data[userId]) {
    data[userId] = { name: name || '', points: 0 };
    save(data);
  }
  return data[userId];
}

function getPoints(userId) {
  const data = load();
  return data[userId] ? data[userId].points : 0;
}

function addPoints(userId, amount) {
  const data = load();
  if (!data[userId]) data[userId] = { name: '', points: 0 };
  data[userId].points += amount;
  save(data);
  return data[userId].points;
}

function getLeaderboard(limit = 10) {
  const data = load();
  return Object.entries(data)
    .map(([userId, v]) => ({ userId, name: v.name, points: v.points }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

module.exports = { initUser, getPoints, addPoints, getLeaderboard };
