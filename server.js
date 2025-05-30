const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/api/pagar', async (req, res) => {
  const { phone, amount, reference } = req.body;

  try {
    const response = await axios.post(
      'https://e2payments.explicador.co.mz/v1/c2b/mpesa-payment/542813',
      {
        client_id: process.env.CLIENT_ID,
        amount: amount.toString(),
        phone,
        reference
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.MPESA_TOKEN}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ status: 'ok', data: response.data });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
