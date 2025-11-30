const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÕES (Vêm das Variáveis de Ambiente do Coolify) ---
const CHATWOOT_URL = process.env.CHATWOOT_URL; // Ex: http://chatwoot-rails:3000 (Rede Interna)
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN; // Token do seu perfil
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || 1;

// --- ROTA QUE RECEBE DA Z-API ---
app.post('/webhook/zapi', async (req, res) => {
    try {
        const data = req.body;
        console.log("Recebido da Z-API:", JSON.stringify(data));

        // Filtra apenas mensagens de texto recebidas (ignora status, grupos, etc por enquanto)
        // Você pode expandir isso depois para aceitar imagem/áudio
        if (data.type === 'ReceivedCallback' && !data.isGroup) {
            const phone = data.phone; // Número do cliente
            const text = data.text;   // Texto da mensagem
            const senderName = data.senderName || phone;

            // 1. Procurar Contato no Chatwoot
            let contactId;
            const searchUrl = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`;
            
            try {
                const searchRes = await axios.get(searchUrl, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                
                if (searchRes.data.payload && searchRes.data.payload.length > 0) {
                    contactId = searchRes.data.payload[0].id;
                    console.log(`Contato existente encontrado: ${contactId}`);
                } else {
                    // 2. Se não existir, Criar Contato
                    console.log("Criando novo contato...");
                    const createContactRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                        inbox_id: CHATWOOT_INBOX_ID,
                        name: senderName,
                        phone_number: `+${phone}`
                    }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                    contactId = createContactRes.data.payload.contact.id;
                }
            } catch (err) {
                console.error("Erro ao buscar/criar contato:", err.response?.data || err.message);
                // Se der erro aqui, tentamos prosseguir ou abortamos. Vamos abortar para não perder msg.
                return res.status(500).send("Erro ao processar contato no Chatwoot");
            }

            // 3. Criar Conversa (Se já existir aberta, o Chatwoot anexa, se não, cria nova)
            console.log(`Enviando mensagem para contato ${contactId}...`);
            await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
                source_id: contactId,
                inbox_id: CHATWOOT_INBOX_ID,
                status: 'open' // Garante que reabre se estiver fechada
            }, { headers: { 'api_access_token': CHATWOOT_TOKEN } })
            .then(async (convRes) => {
                const conversationId = convRes.data.id;
                
                // 4. Inserir a Mensagem na Conversa
                await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
                    content: text,
                    message_type: 'incoming', // Importante: Diz pro Chatwoot que veio do cliente
                    private: false
                }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                
                console.log("Mensagem entregue com sucesso!");
            });
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error("Erro Geral:", error.message);
        res.status(500).send('Erro interno');
    }
});

// Rota de teste simples
app.get('/', (req, res) => res.send('Middleware Z-API rodando!'));

app.listen(3000, () => {
    console.log('Servidor rodando na porta 3000');
});
