const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÕES ---
const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || 1;

// --- ROTA DO WEBHOOK (Z-API) ---
app.post('/webhook/zapi', async (req, res) => {
    // Responde OK imediatamente
    res.status(200).send('Webhook recebido');

    try {
        const data = req.body;
        console.log("📥 [1] Payload recebido:", JSON.stringify(data));

        // Filtro de segurança
        if (data.type === 'ReceivedCallback' && !data.isGroup) {
            
            const phone = data.phone;
            
            // --- CORREÇÃO DO TEXTO AQUI ---
            // A Z-API às vezes manda string direta, às vezes manda objeto { message: "..." }
            let text = '';
            if (typeof data.text === 'string') {
                text = data.text;
            } else if (data.text && data.text.message) {
                text = data.text.message;
            }

            // Se não tiver texto (ex: áudio/imagem que não tratamos ainda), ignora
            if (!text) {
                console.log("⚠️ [2] Mensagem sem texto compatível. Ignorando.");
                return;
            }

            const senderName = data.senderName || `Cliente ${phone}`;
            console.log(`🔄 [3] Processando msg de: ${senderName} | Texto: "${text}"`);
            console.log(`🔗 [Info] Tentando conectar em: ${CHATWOOT_URL}`);

            // --- PASSO 1: Buscar Contato ---
            let contactId;
            const searchUrl = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`;
            
            try {
                const searchRes = await axios.get(searchUrl, { 
                    headers: { 'api_access_token': CHATWOOT_TOKEN } 
                });
                
                if (searchRes.data.payload && searchRes.data.payload.length > 0) {
                    contactId = searchRes.data.payload[0].id;
                    console.log(`✅ [4] Contato encontrado: ID ${contactId}`);
                } else {
                    console.log("🆕 [4] Criando novo contato...");
                    const createContactRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                        inbox_id: CHATWOOT_INBOX_ID,
                        name: senderName,
                        phone_number: `+${phone}`
                    }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                    
                    contactId = createContactRes.data.payload.contact.id;
                    console.log(`✅ [4] Contato criado: ID ${contactId}`);
                }

                // --- PASSO 2: Garantir Conversa ---
                console.log(`⏳ [5] Buscando/Criando conversa para contato ${contactId}...`);
                const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
                    source_id: contactId,
                    inbox_id: CHATWOOT_INBOX_ID,
                    status: 'open'
                }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

                const conversationId = convRes.data.id;
                console.log(`💬 [6] Conversa ID: ${conversationId}`);

                // --- PASSO 3: Enviar Mensagem ---
                console.log(`🚀 [7] Enviando texto...`);
                await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
                    content: text,
                    message_type: 'incoming',
                    private: false
                }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                
                console.log("🎉 [8] SUCESSO TOTAL! Mensagem entregue.");

            } catch (apiError) {
                // Log detalhado do erro do Chatwoot
                console.error("❌ ERRO NA CHAMADA AXIOS:");
                if (apiError.response) {
                    console.error(`Status: ${apiError.response.status}`);
                    console.error(`Dados: ${JSON.stringify(apiError.response.data)}`);
                } else {
                    console.error(apiError.message);
                }
            }
        }

    } catch (error) {
        console.error("❌ Erro grave no script:", error.message);
    }
});

app.get('/', (req, res) => res.send('Middleware Z-API v2 (Correção de Objeto) Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
