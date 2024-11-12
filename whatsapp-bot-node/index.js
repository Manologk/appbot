console.log("Starting WhatsApp Bot...");

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const OpenAI = require('openai')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const fs = require('fs')


// Create logger with debug level
const logger = pino({ 
    level: 'debug',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    }
})


console.log("Initializing connection...");

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: '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' // Replace with your API key
})

// At the top of your file
const conversations = new Map()

const PERSONALITIES = {
    default: "You are a helpful WhatsApp bot assistant. Keep responses concise and friendly. Use emojis occasionally.",
    funny: "You are a comedian bot. Make everything humorous and use lots of jokes. Use funny emojis.",
    professional: "You are a professional business assistant. Keep responses formal and precise. No emojis."
}

const userLimits = new Map()

function checkRateLimit(userId) {
    const now = Date.now()
    const userLimit = userLimits.get(userId) || { count: 0, timestamp: now }
    
    if (now - userLimit.timestamp > 3600000) { // Reset after 1 hour
        userLimit.count = 1
        userLimit.timestamp = now
    } else if (userLimit.count >= 10) { // Limit to 10 requests per hour
        return false
    } else {
        userLimit.count++
    }
    
    userLimits.set(userId, userLimit)
    return true
}

// Function to get GPT response
async function getGPTResponse(message, conversationHistory = []) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { 
                    "role": "system", 
                    "content": "You are a helpful WhatsApp bot assistant. Keep responses concise and friendly. Use emojis occasionally." 
                },
                ...conversationHistory,
                { "role": "user", "content": message }
            ],
            max_tokens: 150
        })
        return completion.choices[0].message.content
    } catch (error) {
        console.error('OpenAI API Error:', error)
        return "Sorry, I'm having trouble thinking right now. Please try again later! 🤔"
    }
}


async function connectToWhatsApp() {
    console.log("Connecting to WhatsApp...");

    // Use the saved authentication data
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    // Create the socket with logger
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: logger  // Add the logger here
    })
    
    // Connection handling
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if(shouldReconnect) {
                connectToWhatsApp()
            }
        } else if(connection === 'open') {
            console.log('Bot is now connected! 🤖')
        }
    })
    
    sock.ev.on('creds.update', saveCreds)
    
    // Message handling
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0]
        
        // Check if it's a group message
        if (!m.message || !m.key.remoteJid.endsWith('@g.us')) return
        
        const messageText = m.message.conversation || 
                          (m.message.extendedTextMessage && m.message.extendedTextMessage.text) || 
                          (m.message.imageMessage && m.message.imageMessage.caption)
        
        if (!messageText) return
        
        const chat = m.key.remoteJid
        const sender = m.key.participant || m.key.remoteJid
        
        // Convert message to lowercase for command checking
        const msg = messageText.toLowerCase()

        // Command handling
        if (msg === '!help') {
            const helpText = `
*Available Commands:* 📝

!ask [question] - Ask me anything
!chat [message] - Have a conversation with me
!help - Show this help message

Example:
!ask What is the capital of France?
!chat Tell me a joke`
            await sock.sendMessage(chat, { text: helpText })
        }
        
        // GPT commands
        else if (msg.startsWith('!ask ') || msg.startsWith('!chat ')) {
            // Show typing indicator
            await sock.sendPresenceUpdate('composing', chat)
            
            // Get the actual question/message
            const query = messageText.slice(msg.startsWith('!ask ') ? 5 : 6)
            
            // In your message handling, before calling getGPTResponse
            const userConversation = conversations.get(sender) || []
            userConversation.push({ role: "user", content: query })

            if (checkRateLimit(sender)) {
                try {
                    // Get response from GPT
                    const response = await getGPTResponse(query, userConversation)
                    
                    // Send the response
                    await sock.sendMessage(chat, { 
                        text: `@${sender.split('@')[0]}, ${response}`,
                        mentions: [sender]
                    })
                } catch (error) {
                    console.error('Error getting GPT response:', error)
                    await sock.sendMessage(chat, { 
                        text: 'Sorry, I encountered an error. Please try again later! 🙏'
                    })
                }
            } else {
                await sock.sendMessage(chat, { 
                    text: "You've reached the hourly limit. Please try again later."
                })
            }
        }
    })
}

// Start the bot
connectToWhatsApp()