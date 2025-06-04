const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // já importado
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Loga as variáveis pra garantir que tão chegando no ambiente de deploy
console.log('CLIENT_ID:', process.env.CLIENT_ID ? '✔️ set' : '❌ missing');
console.log('MPESA_TOKEN:', process.env.MPESA_TOKEN ? '✔️ set' : '❌ missing');

// Função SHA256 (já tem no seu código)
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// --- CONFIGURAÇÃO DO NODEMAILER (colocar aqui, junto das imports) ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,         // coloca seu email no .env, ex: EMAIL_USER=seu-email@gmail.com
    pass: process.env.EMAIL_PASS_APP,     // senha de app do Gmail no .env, ex: EMAIL_PASS_APP=xxxxxx
  },
});

// Função para enviar email
function enviarEmail(destino, assunto, texto) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: destino,
    subject: assunto,
    text: texto,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Erro ao enviar e-mail:', error);
    } else {
      console.log('E-mail enviado:', info.response);
    }
  });
}

// Rota do pagamento
app.post('/api/pagar', async (req, res) => {
  const { phone, amount, reference, metodo, email, nome, pedido } = req.body; // Pegue nome e pedido também se tiver

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

    // Enviar evento para o Facebook (já tem)
    const fbPixelId = process.env.FB_PIXEL_ID;
    const fbAccessToken = process.env.FB_ACCESS_TOKEN;

    if (fbPixelId && fbAccessToken && email && phone) {
      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/${fbPixelId}/events`,
          {
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
                  value: amount,
                },
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${fbAccessToken}`,
            },
          }
        );

        console.log('🎯 Evento de purchase enviado para o Facebook');
      } catch (fbErr) {
        console.error('❌ Erro ao enviar evento pro Facebook:', fbErr.response?.data || fbErr.message);
      }
    }

    // --- AQUI: chama o envio do email assim que a compra for confirmada ---
    if (email) {
      const nomeCliente = nome || 'cliente';
      const textoEmail = `Olá ${nomeCliente}, seu pedido foi recebido com sucesso! Referência: ${reference}. Valor: MZN ${amount}. Obrigado pela compra!`;

      enviarEmail(email, 'Compra Confirmada!', textoEmail);
    }

    res.json({ status: 'ok', data: response.data });
  } catch (err) {
    console.error('Erro na requisição externa:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});


