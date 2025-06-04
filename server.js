const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // já importado
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
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
function enviarEmail(destino, assunto, conteudoHTML) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS_APP,
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: destino,
    subject: assunto,
    html: conteudoHTML,
  };

  transporter.sendMail(mailOptions, (erro, info) => {
    if (erro) {
      console.error('❌ Erro ao enviar email:', erro);
    } else {
      console.log('📧 Email enviado com sucesso:', info.response);
    }
  });
}
async function adicionarNaPlanilha({ nome, email, phone, metodo, amount, reference }) {
  // Parse do JSON das credenciais direto da variável de ambiente
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const spreadsheetId = '1cQEOFLQjNkVyI27jHluGnUxlapg0e-9wcPAXxaepZJc'; // substitua pelo ID da sua planilha

  const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'Africa/Maputo' });

  const novaLinha = [[nome, email, phone, metodo, amount, reference, dataAtual]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: novaLinha,
    },
  });

  console.log('📊 Dados adicionados na planilha');
}

// Rota do pagamento
app.post('/api/pagar', async (req, res) => {
  const { phone, amount, reference, metodo, email, nome, pedido } = req.body;

  console.log('Request body:', req.body);

  if (!phone || !amount || !reference || !metodo) {
    return res.status(400).json({
      status: 'error',
      message: 'phone, amount, reference e metodo são obrigatórios',
    });
  }

  let walletId, token;
  if (metodo === 'mpesa') {
    walletId = process.env.MPESA_WALLET_ID;
    token = process.env.MPESA_TOKEN;
  } else if (metodo === 'emola') {
    walletId = process.env.EMOLA_WALLET_ID;
    token = process.env.EMOLA_TOKEN;
  } else {
    return res.status(400).json({
      status: 'error',
      message: 'Método inválido. Use mpesa ou emola.',
    });
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

    // Enviar evento para o Facebook
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

    // Enviar e-mail se tiver email
    const nomeCliente = nome || 'Cliente';

    if (email) {
      const textoEmailHTML = `
        <p>Olá ${nomeCliente}, seu pedido foi recebido com sucesso!</p>
        <p>Referência: ${reference}. Valor: MZN ${amount}.</p>
        <p>Obrigado pela compra!</p>
        <p>Para acessar o produto, clique no link: 
        <a href="https://club.membify.com.br/app" target="_blank">Acessar produto</a></p>
      `;

      enviarEmail(email, 'Compra Confirmada!', textoEmailHTML);
    }

    // Adicionar na planilha
    try {
      await adicionarNaPlanilha({
        nome: nomeCliente,
        email,
        phone,
        metodo,
        amount,
        reference,
      });
    } catch (err) {
      console.error('Erro ao adicionar dados na planilha:', err);
    }

    // Retorno da API
    res.json({ status: 'ok', data: response.data });
  } catch (err) {
    console.error('Erro na requisição externa:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});


