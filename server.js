const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Loga as variáveis pra garantir que tão chegando no ambiente de deploy
console.log('CLIENT_ID:', process.env.CLIENT_ID ? '✔️ set' : '❌ missing');
console.log('MPESA_TOKEN:', process.env.MPESA_TOKEN ? '✔️ set' : '❌ missing');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

app.post('/api/pagar', async (req, res) => {
  const { phone, amount, reference, metodo, email } = req.body;

  console.log('Request body:', req.body);

  if (!phone || !amount || !reference || !metodo) {
    return res.status(400).json({ status: 'error', message: 'phone, amount, reference e metodo são obrigatórios' });
  }

  let walletId, token;
  if (metodo === 'mpesa') {
    walletId = process.env.MPESA_WALLET_ID;
    token = process.env.MPESA_TOKEN;
  } else if (metodo === 'emola') {
    walletId = process.env.EMOLA_WALLET_ID;
    token = process.env.EMOLA_TOKEN;
  } else {
    return res.status(400).json({ status: 'error', message: 'Método inválido. Use mpesa ou emola.' });
  }

  const url = `https://e2payments.explicador.co.mz/v1/c2b/${metodo}-payment/${walletId}`;

  try {
    const response = await axios.post(
      url,
      {
        client_id: process.env.CLIENT_ID,
        amount: amount.toString(),
        phone,
        reference,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Resposta da API externa:', response.data);

    // 🔥 Enviar evento para o Facebook
    const fbPixelId = process.env.FB_PIXEL_ID;
    const fbAccessToken = process.env.FB_ACCESS_TOKEN;

    if (fbPixelId && fbAccessToken && email && phone) {
      try {
  await axios.post(
  `https://graph.facebook.com/v19.0/${fbPixelId}/events`,
  {
    test_event_code: 'TEST46450', // 👈 AQUI está seu test code
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        user_data: {
          em: sha256(email.trim().toLowerCase()),
          ph: sha256(phone.replace(/\D/g, '')),
        },
        custom_data: {
          currency: 'MZN',
          value: amount
        }
      }
    ]
  },
  {
    headers: {
      Authorization: `Bearer ${fbAccessToken}`
    }
  }
);

        console.log('🎯 Evento de purchase enviado para o Facebook');
      } catch (fbErr) {
        console.error('❌ Erro ao enviar evento pro Facebook:', fbErr.response?.data || fbErr.message);
      }
    }

    res.json({ status: 'ok', data: response.data });

  } catch (err) {
    console.error('Erro na requisição externa:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: err.response?.data || err.message });
  }
});
// ... todo teu app.post('/api/pagar', ...) aqui certinho

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});


