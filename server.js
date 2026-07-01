const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.post('/ai', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'API key not set' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: req.body.model || 'claude-haiku-4-5-20251001', max_tokens: req.body.max_tokens || 800, system: req.body.system || '', messages: req.body.messages || [] })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(process.env.PORT || 3000);
