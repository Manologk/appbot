const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const { GoogleGenerativeAI } = require("@google/generative-ai")
const qrcode = require('qrcode-terminal')
const pino = require('pino')
require('dotenv').config()

// Global variables and maps
const userStats = new Map()
const memberStats = new Map()
const chatHistory = new Map()

// Initialize Gemini and logger
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const logger = pino({ level: 'silent' })

// Helper functions
function updateUserStats(userId, messageType = 'text') {
    const stats = userStats.get(userId) || {
        commands: 0,
        messages: 0,
        lastActive: null,
        lastUsed: null,
        messageTypes: {
            text: 0,
            commands: 0,
            media: 0
        }
    }
    
    stats.messages++
    stats.lastActive = new Date()
    stats.lastUsed = new Date()
    
    if (messageType === 'command') {
        stats.commands++
        stats.messageTypes.commands++
    } else {
        stats.messageTypes[messageType]++
    }
    
    userStats.set(userId, stats)
    return stats
}

function getUserStats(userId) {
    return userStats.get(userId) || {
        commands: 0,
        messages: 0,
        lastActive: null,
        lastUsed: null,
        messageTypes: {
            text: 0,
            commands: 0,
            media: 0
        }
    }
}

async function getGeminiResponse(message) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" })
        const result = await model.generateContent(message)
        const response = await result.response
        return response.text()
    } catch (error) {
        console.error('Gemini API Error:', error)
        return "Sorry, I'm having trouble thinking right now. Please try again later! 🤔"
    }
}

async function analyzeGroupActivity(sock, groupId) {
    try {
        const members = await sock.groupMetadata(groupId).then(meta => meta.participants)
        const memberStats = members.map(member => {
            const stats = getUserStats(member.id)
            return {
                id: member.id,
                messageCount: stats.messages || 0,
                lastActive: stats.lastActive,
                daysSinceLastActive: stats.lastActive ? 
                    Math.floor((new Date() - new Date(stats.lastActive)) / (1000 * 60 * 60 * 24)) : 
                    Infinity
            }
        })

        // Sort by message count and last activity
        return memberStats.sort((a, b) => {
            if (a.messageCount === b.messageCount) {
                return b.daysSinceLastActive - a.daysSinceLastActive
            }
            return a.messageCount - b.messageCount
        })
    } catch (error) {
        console.error('Error analyzing group activity:', error)
        return []
    }
}

// Add these helper functions
function getRandomMember(members) {
    return members[Math.floor(Math.random() * members.length)]
}

function createPersonalityResponse(member, trait) {
    const responses = [
        `Definitely @${member.split('@')[0]}! They're always ${trait} 😄`,
        `Without a doubt, it's @${member.split('@')[0]} ${trait}! 🎯`,
        `My analysis shows that @${member.split('@')[0]} is ${trait} 🤔`,
        `I'd say @${member.split('@')[0]} takes the crown for being ${trait} 👑`,
        `Based on my calculations, @${member.split('@')[0]} is ${trait} 🎊`
    ]
    return responses[Math.floor(Math.random() * responses.length)]
}

// Main WhatsApp connection function
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: logger
    })
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if(qr) {
            console.log('QR Code received, please scan!')
        }
        
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
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0]
        if (!m.message) return
        
        const messageText = m.message.conversation || 
                          (m.message.extendedTextMessage && m.message.extendedTextMessage.text) || 
                          (m.message.imageMessage && m.message.imageMessage.caption)
        
        if (!messageText) return
        
        const chat = m.key.remoteJid
        const sender = m.key.participant || m.key.remoteJid
        const isGroup = chat.endsWith('@g.us')
        const msg = messageText.toLowerCase()

        // Update stats for every message
        const messageType = msg.startsWith('!') ? 'command' : 'text'
        updateUserStats(sender, messageType)

        // Command handling
        if (msg === '!help') {
            const helpText = `
*Available Commands:* 📝

Basic Commands:
!ask [question] - Ask me anything
!chat [message] - Have a conversation
!stats - View your usage statistics
${isGroup ? '!groupstats - View group statistics' : ''}

Fun Group Commands:
who is the quietest - Find the quietest member
who is the loudest - Find the most active member
who likes black label - Random fun traits
who is [any trait] - Random member selection

Examples:
!ask What is quantum computing?
!chat Tell me a story
who is the funniest person here?
who likes to party the most?

Note: Fun commands work with "who" instead of "!" 😊`

            await sock.sendMessage(chat, { text: helpText })
        }
        
        else if (msg === '!stats') {
            const stats = getUserStats(sender)
            const response = `
*Your Activity Stats* 📊

Total Messages: ${stats.messages}
Commands Used: ${stats.commands}
Last Active: ${stats.lastActive ? stats.lastActive.toLocaleString() : 'Never'}
Text Messages: ${stats.messageTypes.text}
`
            await sock.sendMessage(chat, { 
                text: response,
                mentions: [sender]
            })
        }
        
        else if (msg.startsWith('!ask ')) {
            await sock.sendPresenceUpdate('composing', chat)
            const query = messageText.slice(5)
            const response = await getGeminiResponse(query)
            await sock.sendMessage(chat, { 
                text: `@${sender.split('@')[0]}, ${response}`,
                mentions: [sender]
            })
        }
        
        else if (msg.startsWith('!chat ')) {
            await sock.sendPresenceUpdate('composing', chat)
            const query = messageText.slice(6)
            try {
                const response = await getGeminiResponse(query)
                await sock.sendMessage(chat, { 
                    text: `@${sender.split('@')[0]}, ${response}`,
                    mentions: [sender]
                })
            } catch (error) {
                console.error('Chat error:', error)
                await sock.sendMessage(chat, { 
                    text: 'Sorry, I had trouble processing that. Please try again! 🙏'
                })
            }
        }
        
        else if (msg === '!quiet' || msg === '!quietest') {
            if (!isGroup) {
                await sock.sendMessage(chat, { 
                    text: 'This command can only be used in groups!' 
                })
                return
            }

            const memberActivity = await analyzeGroupActivity(sock, chat)
            if (memberActivity.length === 0) {
                await sock.sendMessage(chat, { 
                    text: 'No activity data available yet!' 
                })
                return
            }

            // Get the quietest member(s)
            const quietestMembers = memberActivity.slice(0, 3)
            let response = '*Quietest Members Analysis* 🤫\n\n'

            for (const [index, member] of quietestMembers.entries()) {
                const memberName = `@${member.id.split('@')[0]}`
                response += `${index + 1}. ${memberName}\n`
                response += `Messages: ${member.messageCount}\n`
                response += `Last Active: ${member.lastActive ? 
                    `${member.daysSinceLastActive} days ago` : 
                    'Never active'}\n\n`
            }

            await sock.sendMessage(chat, { 
                text: response,
                mentions: quietestMembers.map(m => m.id)
            })
        }
        
        else if (msg.startsWith('who ')) {
            if (!isGroup) {
                await sock.sendMessage(chat, { 
                    text: 'This command only works in groups! 👥'
                })
                return
            }

            const members = await sock.groupMetadata(chat).then(meta => meta.participants)
            const randomMember = getRandomMember(members)
            const query = msg.slice(4).toLowerCase()

            let response = ''
            
            // Specific trait matching
            if (query.includes('quiet')) {
                const memberActivity = await analyzeGroupActivity(sock, chat)
                const quietestMember = memberActivity[0]
                response = createPersonalityResponse(quietestMember.id, 'the quietest')
            }
            else if (query.includes('loud') || query.includes('active')) {
                const memberActivity = await analyzeGroupActivity(sock, chat)
                const loudestMember = memberActivity[memberActivity.length - 1]
                response = createPersonalityResponse(loudestMember.id, 'the most active')
            }
            // Fun random traits
            else if (query.includes('black label') || 
                     query.includes('drink') || 
                     query.includes('party')) {
                response = createPersonalityResponse(randomMember.id, 'the life of the party')
            }
            else if (query.includes('smart') || query.includes('intelligent')) {
                response = createPersonalityResponse(randomMember.id, 'the smartest')
            }
            else if (query.includes('funny')) {
                response = createPersonalityResponse(randomMember.id, 'the funniest')
            }
            else if (query.includes('sleep') || query.includes('lazy')) {
                response = createPersonalityResponse(randomMember.id, 'always sleeping')
            }
            else {
                // Generic random selection for any other query
                response = createPersonalityResponse(randomMember.id, 'exactly like that')
            }

            await sock.sendMessage(chat, { 
                text: response,
                mentions: [randomMember.id]
            })
        }
    })
}

// Start the bot
connectToWhatsApp().catch(err => {
    console.error('Fatal error:', err)
})