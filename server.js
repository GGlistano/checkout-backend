/*******************************
 * Visionpay Server (Express)
 * Full file – organizado + SMS Infobip integrado
 *******************************/
require('dotenv').config(); // local dev; no Railway ignora

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

/* ---------------------------------------------
   Firebase Admin
----------------------------------------------*/
const admin = require('firebase-admin');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
};

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

/* ---------------------------------------------
   App base
----------------------------------------------*/
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Debug rápido de envs críticos (não loga secretos!)
console.log('CLIENT_ID:', process.env.CLIENT_ID ? '✔️ set' : '❌ missing');
console.log('MPESA_TOKEN:', process.env.MPESA_TOKEN ? '✔️ set' : '❌ missing');

/* ---------------------------------------------
   Utils
----------------------------------------------*/
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Formata msisdn -> +258...
function toMozE164(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('258')) return `+${n}`;
  if (/^[8]\d{8}$/.test(n)) return `+258${n}`;
  if (/^\d{8}$/.test(n)) return `+2588${n}`;
  return n.startsWith('+') ? n : `+${n}`;
}

/* ---------------------------------------------
   Email (Gmail)
----------------------------------------------*/
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

/* ---------------------------------------------
   Pushcut (notificações internas)
----------------------------------------------*/
async function notificarPushcut() {
  try {
    await axios.post('https://api.pushcut.io/Ug0n96qt-uMMwYFZRRHk_/notifications/Venda%20recebida');
    console.log('✅ Pushcut enviado direto, sem payload');
  } catch (err) {
    console.error('❌ Pushcut falhou:', err.response?.data || err.message);
  }
}

async function notificarPushcutSecundario() {
  try {
    await axios.post('https://api.pushcut.io/q-XmBT8fFsxnWbOyfaBQH/notifications/Venda%20Realizada');
    console.log('✅ Segundo Pushcut enviado');
  } catch (err) {
    console.error('❌ Erro ao enviar segundo Pushcut:', err.response?.data || err.message);
  }
}

/* ---------------------------------------------
   Google Sheets (registro de compras)
----------------------------------------------*/
const { google } = require('googleapis');

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
    requestBody: { values: novaLinha },
  });

  console.log('📊 Dados adicionados na planilha');
}

/* ---------------------------------------------
   WhatsApp - recuperação (Z-API)
----------------------------------------------*/
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
      { phone: telefoneFormatado, message: mensagem },
      { headers: { 'Client-Token': 'F1850a1deea6b422c9fa8baf8407628c5S' } }
    );

    console.log('✅ Mensagem de recuperação enviada via WhatsApp');
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem de recuperação:', err.response?.data || err.message);
  }
}

/* ---------------------------------------------
   Firestore helpers
----------------------------------------------*/
async function salvarTransacaoFalhada({ phone, metodo, reference, erro }) {
  try {
    await db.collection('transacoes_falhadas').add({
      phone, metodo, reference, erro,
      status: 'falhou',
      created_at: new Date(),
    });
    console.log(`⚠️ Transação falhada salva: ${erro}`);
  } catch (err) {
    console.error('❌ Erro ao salvar transação falhada:', err);
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

/* ---------------------------------------------
   Infobip SMS (axios)
----------------------------------------------*/
const INFOBIP_BASE_URL = process.env.INFOBIP_BASE_URL; // ex: https://nm3q8e.api.infobip.com
const INFOBIP_API_KEY  = process.env.INFOBIP_API_KEY;  // "App xxx..."
const SMS_SENDER       = process.env.SMS_SENDER || 'ServiceSMS';

async function sendSmsInfobip({ to, text, externalId }) {
  const payload = {
    messages: [{
      from: SMS_SENDER,
      destinations: [{ to }],
      text,
      ...(externalId ? { callbackData: externalId } : {})
    }]
  };

  const res = await axios.post(
    `${INFOBIP_BASE_URL}/sms/2/text/advanced`,
    payload,
    {
      headers: {
        Authorization: `App ${INFOBIP_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 10000,
    }
  );

  return res.data;
}

/* ---------------------------------------------
   Rota principal: /api/pagar
----------------------------------------------*/
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

  // credenciais e endpoint do gateway
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
    // 1) processa pagamento no gateway
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

    // 2) Facebook CAPI (se tiver credenciais)
    const fbPixelId = process.env.FB_PIXEL_ID;
    const fbAccessToken = process.env.FB_ACCESS_TOKEN;

    if (fbPixelId && fbAccessToken && email && phone) {
      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/${fbPixelId}/events`,
          {
            data: [{
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              action_source: 'website',
              user_data: {
                em: email ? sha256(email.trim().toLowerCase()) : undefined,
                ph: phone ? sha256(phone.replace(/\D/g, '')) : undefined,
                fbp: fbp || undefined,
                fbc: fbc || undefined,
              },
              custom_data: { currency: 'MZN', value: amount },
            }],
          },
          { headers: { Authorization: `Bearer ${fbAccessToken}` } }
        );
        console.log('🎯 Evento de purchase enviado para o Facebook');
      } catch (fbErr) {
        console.error('❌ Erro ao enviar evento pro Facebook:', fbErr.response?.data || fbErr.message);
      }
    }

    // 3) Email
    const nomeCliente = nome || 'Cliente';
    if (email) {
      const textoEmailHTML = `
        <p>Olá ${nomeCliente}, seu pedido foi recebido com sucesso!</p>
        <p>Referência: ${reference}. Valor: MZN ${amount}.</p>
        <p>É um enorme prazer te ter por aqui</p>
        <p>Para acessar a sua conta, clique no link: 
        <a href="https://wa.me/258858093864?text=ola,%20quero%20receber%20meu%20acceso!" target="_blank">Acessar produto</a></p>
      `;
      enviarEmail(email, 'Compra Confirmada!', textoEmailHTML);
    }

    // 4) Planilha
    try {
      await adicionarNaPlanilha({
        nome: nomeCliente, email, phone, metodo, amount, reference,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content
      });
    } catch (err) {
      console.error('Erro ao adicionar dados na planilha:', err);
    }

    // 5) Firestore – compras + recuperação opcional
    try {
      await salvarCompra({
        nome: nomeCliente, email, phone, metodo, amount, reference,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content
      });

      if (req.body.recuperacao) {
        await db.collection('compras_recuperacao').add({
          nome: nomeCliente, email, phone, metodo, amount, reference,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log("💾 Compra de recuperação salva na coleção 'compras_recuperacao'");
      }
    } catch (err) {
      console.error('❌ Erro ao salvar no Firebase:', err);
    }

    // 6) Firestore – usuários (saldo inicial)
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

    // 7) SMS Infobip – número do pagador: response (gateway) -> req (gateway) -> form
    const phoneFromGatewayResp =
      response?.data?.msisdn || response?.data?.payerPhone || response?.data?.debited_msisdn || null;
    const phoneFromGatewayReq =
      req.body.payerPhone || req.body.msisdn || req.body.debited_msisdn || req.body.msisdn_payer || null;
    const phoneFromForm =
      req.body.phone || req.body.phone_number || req.body.customer_phone || null;

    const rawTel = phoneFromGatewayResp || phoneFromGatewayReq || phoneFromForm;
    const to = toMozE164(rawTel);

    const planNm = req.body.planName || req.body.product || req.body.item || pedido || null;
    const txIdFinal = req.body.txId || req.body.transactionId || reference || req.body.orderId;

    if (to && txIdFinal) {
      global.__sent = global.__sent || new Set();
      const key = `${to}__${txIdFinal}`;
      if (!global.__sent.has(key)) {
        const smsText =
          `Olá, tudo bem? Aqui fala a equipe do GoogleRewards para você poder acessar a sua conta oficial mande uma mensagem no WhatsApp para:  858322793. pagamento confirmado  ${amount} MZN${planNm ? ` - ${planNm}` : ''}.\n` +
          `Ref: ${txIdFinal}\ngrupo vision.`;
        try {
          await sendSmsInfobip({ to, text: smsText, externalId: txIdFinal });
          global.__sent.add(key);
          console.log('✅ SMS enviado para', to);
        } catch (e) {
          console.error('❌ Falha ao enviar SMS:', e.response?.data || e.message);
        }
      } else {
        console.log('⏭️ SMS já enviado (skip)', key);
      }
    } else {
      console.warn('⚠️ Telefone/txId inválido; SMS não enviado');
    }

    // 8) WhatsApp (confirmação)
    try {
      const telefoneDestino = (whatsapp && whatsapp.length)
        ? (whatsapp.startsWith('258') ? whatsapp : `258${whatsapp.replace(/^0/, '')}`)
        : (phone?.startsWith('258') ? phone : `258${String(phone || '').replace(/^0/, '')}`);

      const mensagem = `👋 Olá ${nomeCliente}!

✅ Sua compra foi confirmada com sucesso.

📌 Referência: *${reference}*  
💵 Valor: *MZN ${amount}*

Clique no link abaixo para poder receber o seu acesso:
https://wa.me/258858093864?text=ola,%20quero%20receber%20meu%20acceso!`;

      await axios.post(
        'https://api.z-api.io/instances/3E253C0E919CB028543B1A5333D349DF/token/4909422EC4EB52D5FAFB7AB1/send-text',
        { phone: telefoneDestino, message: mensagem },
        { headers: { 'Client-Token': 'F1850a1deea6b422c9fa8baf8407628c5S' } }
      );

      console.log('✅ Mensagem enviada via WhatsApp (Z-API)');
      await notificarPushcut();
      await notificarPushcutSecundario();
    } catch (err) {
      console.error('❌ Erro ao enviar mensagem pelo WhatsApp:', err.response?.data || err.message);
    }

    // 9) resposta final ÚNICA
    return res.json({ status: 'ok', data: response.data });

  } catch (err) {
    // Falha no pagamento (requisição externa)
    const erroDetalhado = err?.response?.data?.message || err.message || 'Erro desconhecido';
    console.error('Erro na requisição externa:', erroDetalhado);

    // Salva falha
    await salvarTransacaoFalhada({ phone, metodo, reference, erro: erroDetalhado });

    // Agenda recuperação por WhatsApp
    setTimeout(() => {
      enviarMensagemWhatsAppRecuperacao(phone, nome || 'Cliente');
    }, 2 * 60 * 1000);

    return res.status(500).json({ status: 'error', message: erroDetalhado });
  }
});

/* ---------------------------------------------
   Delivery Reports (DLR) – Infobip
----------------------------------------------*/
app.post('/webhooks/infobip/dlr', async (req, res) => {
  try {
    const { results = [] } = req.body || {};
    for (const r of results) {
      const to = r.to;
      const status = r.status?.groupName;
      const description = r.status?.description;
      const cbData = r.callbackData || r.bulkId || r.messageId; // callbackData = txIdFinal (se enviado)

      const key = `${to}__${cbData}`;
      await db.collection('sms_logs').doc(key).set({
        dlr: { status, description, raw: r, updated_at: new Date() }
      }, { merge: true });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('DLR ERROR', e.message);
    res.sendStatus(200); // sempre 200 pra não chover retry
  }
});

/* ---------------------------------------------
   Função genérica: processarUpsell
----------------------------------------------*/
async function processarUpsell({ phone, metodo, email, nome, whatsapp, amount, reference, colecao }) {
  let walletId, token;
  if (metodo === 'mpesa') {
    walletId = process.env.MPESA_WALLET_ID;
    token = process.env.MPESA_TOKEN;
  } else if (metodo === 'emola') {
    walletId = process.env.EMOLA_WALLET_ID;
    token = process.env.EMOLA_TOKEN;
  } else {
    throw new Error('Método inválido. Use mpesa ou emola.');
  }

  const url = `https://e2payments.explicador.co.mz/v1/c2b/${metodo}-payment/${walletId}`;

  // chamada para API externa de pagamento
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

  // salva compra no Firebase
  await db.collection(colecao).add({
    nome,
    email,
    phone,
    whatsapp: whatsapp || '',
    metodo,
    amount,
    reference,
    created_at: new Date(),
  });

  return response.data;
}

/* ---------------------------------------------
   Rotas de Upsell
----------------------------------------------*/
app.post('/api/upsell1', async (req, res) => {
  const { phone, metodo, email, nome, whatsapp } = req.body;
  try {
    const data = await processarUpsell({
      phone,
      metodo,
      email,
      nome,
      whatsapp,
      amount: 349,
      reference: `UPSELL1-${Date.now()}`,
      colecao: 'upsell1_compras'
    });
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('❌ Erro no upsell1:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/upsell2', async (req, res) => {
  const { phone, metodo, email, nome, whatsapp } = req.body;
  try {
    const data = await processarUpsell({
      phone,
      metodo,
      email,
      nome,
      whatsapp,
      amount: 250,
      reference: `UPSELL2-${Date.now()}`,
      colecao: 'upsell2_compras'
    });
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('❌ Erro no upsell2:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/upsell3', async (req, res) => {
  const { phone, metodo, email, nome, whatsapp } = req.body;
  try {
    const data = await processarUpsell({
      phone,
      metodo,
      email,
      nome,
      whatsapp,
      amount: 149,
      reference: `UPSELL3-${Date.now()}`,
      colecao: 'upsell3_compras'
    });
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('❌ Erro no upsell3:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------------------------------------------
   Start
----------------------------------------------*/
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
