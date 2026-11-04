const mongoose = require('mongoose');

async function connectDatabase() {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL is required');

  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB', { database: mongoose.connection.name });
}

module.exports = { connectDatabase };
