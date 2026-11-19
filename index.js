import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
const app = express();
const PORT = process.env.PORT || 5000;

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.18t8vhf.mongodb.net/`);

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
