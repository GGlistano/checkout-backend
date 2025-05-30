const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Loga as variáveis pra garantir que tão chegando no ambiente de deploy
console.log('CLIENT_ID:', process.env.CLIENT_ID ? '✔️ set' : '❌ missing');
console.log('MPESA_TOKEN:', process.env.MPESA_TOKEN ? '✔️ set' : '❌ missing');

app.post('/api/pagar', async (req, res) => {
  const { phone, amount, reference } = req.body;

  console.log('Request body:', req.body);

  if (!phone || !amount || !reference) {
    return res.status(400).json({ status: 'error', message: 'phone, amount and reference are required' });
  }

  try {
    const response = await axios.post(
      'https://e2payments.explicador.co.mz/v1/c2b/mpesa-payment/542813',
      {
        client_id: process.env.CLIENT_ID,
        amount: amount.toString(),
        phone,
        reference,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.MPESA_TOKEN}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Resposta da API externa:', response.data);

    res.json({ status: 'ok', data: response.data });
  } catch (err) {
    console.error('Erro na requisição externa:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
