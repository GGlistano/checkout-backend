const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const { initializeApp, cert } = require('firebase-admin/app');
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
};

initializeApp({
  credential: cert(serviceAccount),
});
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

console.log('CLIENT_ID:', process.env.CLIENT_ID ? '✔️ set' : '❌ missing');
console.log('MPESA_TOKEN:', process.env.MPESA_TOKEN ? '✔️ set' : '❌ missing');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS_APP,
  },
});

function enviarEmail(destino, assunto, conteudoHTML) {
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

async function adicionarNaPlanilha({ nome, email, phone, metodo, amount, reference, utm_source, utm_medium, utm_campaign, utm_term, utm_content }) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const spreadsheetId = '1cQEOFLQjNkVyI27jHluGnUxlapg0e-9wcPAXxaepZJc';
  const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'Africa/Maputo' });

  const novaLinha = [[nome, email, phone, metodo, amount, reference, dataAtual, utm_source, utm_medium, utm_campaign, utm_term, utm_content]];

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


const db = getFirestore();
// Função de recuperação
async function enviarMensagemWhatsAppRecuperacao(telefone, nomeCliente = '') {
  try {
    const telefoneFormatado = telefone.startsWith('258') ? telefone : `258${telefone.replace(/^0/, '')}`;

    const mensagem = `⚠️ Olá${nomeCliente ? ' ' + nomeCliente : ''}! Parece que houve um erro na sua tentativa de pagamento…

Mas temos uma notícia boa 🤑

Conseguimos liberar um acesso especial: em vez de pagar 197 MZN, você pode acessar tudo por apenas **97 MZN** (por tempo limitado)!

👉 Finalize aqui agora:
https://lifeboostsecrets.online/rec/
Se tiver dúvidas, é só responder por aqui. Estamos te esperando!`;

    await axios.post(
      'https://api.z-api.io/instances/3E253C0E7BA3B028DAC01664B40E8DC7/token/557A2D63524922D69AE44772/send-text',
      {
        phone: telefoneFormatado,
        message: mensagem
      },
      {
        headers: {
          'Client-Token': 'F1850a1deea6b422c9fa8baf8407628c5S'
        }
      }
    );

    console.log('✅ Mensagem de recuperação enviada via WhatsApp');
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem de recuperação:', err.response?.data || err.message);
  }
}
// 👇 Função que salva as transações falhadas
async function salvarTransacaoFalhada({ phone, metodo, reference, erro }) {
  try {
    await db.collection("transacoes_falhadas").add({
      phone,
      metodo,
      reference,
      erro,
      status: "falhou",
      created_at: new Date(),
    });
    console.log(`⚠️ Transação falhada salva: ${erro}`);
  } catch (err) {
    console.error("❌ Erro ao salvar transação falhada:", err);
  }
}
async function salvarCompra({ nome, email, phone, whatsapp, metodo, amount, reference, utm_source, utm_medium, utm_campaign, utm_term, utm_content }) {
  const dados = {
    nome,
    email,
    phone,
    whatsapp: whatsapp || '',
    metodo,
    amount,
    reference,
    created_at: new Date(),
    utm: {
      source: utm_source || '',
      medium: utm_medium || '',
      campaign: utm_campaign || '',
      term: utm_term || '',
      content: utm_content || '',
    },
  };

  const docRef = await db.collection('compras').add(dados);
  console.log(`✅ Compra salva no Firebase com ID: ${docRef.id}`);
}


app.post('/api/pagar', async (req, res) => {
  const {
    phone, amount, reference, metodo, email, nome, pedido, whatsapp,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbc, fbp
  } = req.body;

  console.log('Request body:', req.body);
  console.log('UTMs capturados:', { utm_source, utm_medium, utm_campaign, utm_term, utm_content });

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
                  em: email ? sha256(email.trim().toLowerCase()) : undefined,
                  ph: phone ? sha256(phone.replace(/\D/g, '')) : undefined,
                  fbp: fbp || undefined,
                  fbc: fbc || undefined,
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

    try {
      await adicionarNaPlanilha({ nome: nomeCliente, email, phone, metodo, amount, reference, utm_source, utm_medium, utm_campaign, utm_term, utm_content });
    } catch (err) {
      console.error('Erro ao adicionar dados na planilha:', err);
    }

 try {
      await salvarCompra({ nome: nomeCliente, email, phone, metodo, amount, reference, utm_source, utm_medium, utm_campaign, utm_term, utm_content });
     // Salvar também na coleção 'compras_recuperacao' se for recuperação
  if (req.body.recuperacao) {
    await db.collection('compras_recuperacao').add({
      nome: nomeCliente,
      email,
      phone,
      metodo,
      amount,
      reference,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_term,
      utm_content,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("💾 Compra de recuperação salva na coleção 'compras_recuperacao'");
  }
    } catch (err) {
      console.error('❌ Erro ao salvar no Firebase:', err);
    }
    try {
      const userRef = db.collection('usuarios');
      const q = await userRef.where('telefone', '==', phone).get();

      if (q.empty) {
        await userRef.add({
          nome: nomeCliente,
          telefone: phone,
          saldo: 200,
          dataCadastro: new Date(),
        });
        console.log(`📥 Novo usuário salvo em 'usuarios': ${nomeCliente}`);
      } else {
        console.log('👀 Usuário já existe na coleção "usuarios"');
      }
    } catch (err) {
      console.error('❌ Erro ao salvar usuário em "usuarios":', err);
    }

    try {
      const telefoneDestino = whatsapp.startsWith('258') ? whatsapp : `258${whatsapp.replace(/^0/, '')}`;
     const mensagem = `👋 Olá ${nomeCliente}!

✅ Sua compra foi confirmada com sucesso.

📌 Referência: *${reference}*  
💵 Valor: *MZN ${amount}*

Para liberar o seu acesso à plataforma, clique no botão abaixo para enviar automaticamente a mensagem no nosso canal oficial com suporte via WhatsApp.

✅ Basta clicar em enviar e a Natália vai te acompanhar em todo o processo.

https://wa.me/258865984978?text=Ol%C3%A1%2C%20quero%20receber%20o%20meu%20acesso `;

      await axios.post(
        'https://api.z-api.io/instances/3E253C0E919CB028543B1A5333D349DF/token/4909422EC4EB52D5FAFB7AB1/send-text',
        { phone: telefoneDestino, message: mensagem },
        { headers: { 'Client-Token': 'F1850a1deea6b422c9fa8baf8407628c5S' } }
      );

      console.log('✅ Mensagem enviada via WhatsApp (Z-API)');
    } catch (err) {
      console.error('❌ Erro ao enviar mensagem pelo WhatsApp:', err.response?.data || err.message);
    }

    res.json({ status: 'ok', data: response.data });
  } catch (err) {
    const erroDetalhado = err?.response?.data?.message || err.message || "Erro desconhecido";

console.error('Erro na requisição externa:', erroDetalhado);

// Salvar falha no Firestore
await salvarTransacaoFalhada({
  phone,
  metodo,
  reference,
  erro: erroDetalhado
});

// ⏱️ Agenda envio de mensagem de recuperação
setTimeout(() => {
  enviarMensagemWhatsAppRecuperacao(phone, nome);
}, 2 * 60 * 1000);

res.status(500).json({ status: 'error', message: erroDetalhado });

  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
