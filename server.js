import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// JSON Body Parser
app.use(express.json());

// POST-Endpoint
app.post('/post', (req, res) => {
  console.log("Daten angekommen:");
  console.log(req.body);
  console.log("------");

  res.send("OK");
});

// Port aus .env, Standard 3000
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
