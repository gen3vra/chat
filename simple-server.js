import express from 'express';
import {WebSocketServer, WebSocket} from 'ws';
import {createServer} from 'http';
import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment configuration
const isDevelopment = process.env.NODE_ENV !== 'production';
const PRODUCTION_BASE_URL = 'https://rose.dev/chat';

// Log environment info
console.log(`Environment: ${isDevelopment ? 'development' : 'production'}`);
if (!isDevelopment) {
  console.log(`Production base URL: ${PRODUCTION_BASE_URL}`);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({server, path: '/ws'});

// Configure static file serving based on environment
if (isDevelopment) {
  // Development: serve files from root
  app.use(express.static('public'));
} else {
  // Production: handle subdirectory if needed
  const basePath = new URL(PRODUCTION_BASE_URL).pathname;
  if (basePath !== '/') {
    app.use(basePath, express.static('public'));
    console.log(`Serving static files from: ${basePath}`);
  } else {
    app.use(express.static('public'));
  }
}

// Simple name generation
const firstNames = ['Fire', 'Silver', 'Blue', 'Red', 'Golden', 'Crystal', 'Shadow', 'Swift', 'Bright', 'Wild'];
const secondNames = ['Cat', 'Wolf', 'Dragon', 'Eagle', 'Star', 'Phoenix', 'Tiger', 'Falcon', 'Lion', 'Fox'];
// TODO: Handler for specific passwords that give you secret names
const secretNames = ['Gen'];

// Word filter
const filterWords = ['filter', 'me'];

// Connected users
const connectedUsers = new Map();

// Message storage (in memory)
const messages = [];
let messageIdCounter = 1;
let clientIdCounter = 1;

// User identity storage (persistent across sessions)
const userIdentities = new Map(); // passcode -> { id, username, avatar, clientId , canSendMessages, lastSeen }

function generatePasscode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 100; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateUserId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function generateUsername() {
  const first = firstNames[Math.floor(Math.random() * firstNames.length)];
  const second = secondNames[Math.floor(Math.random() * secondNames.length)];
  const number = Math.floor(Math.random() * 99) + 1;
  return `${first}${second}${number}`;
}

function generateAvatar(username) {
  return username.substring(0, 2).toUpperCase();
}

function filterMessage(text) {
  let filteredText = text;
  filterWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filteredText = filteredText.replace(regex, '*');
  });
  return filteredText;
}

function broadcast(message, excludeId = null) {
  connectedUsers.forEach((user, id) => {
    if (id !== excludeId && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(JSON.stringify(message));
    }
  });
}

function broadcastToAll(message) {
  const messageStr = JSON.stringify(message);
  connectedUsers.forEach((user, id) => {
    if (user.ws.readyState === WebSocket.OPEN) {
      try {
        user.ws.send(messageStr);
      } catch (error) {
        console.error(`Failed to send message to user ${user.username}:`, error);
        // Remove dead connection
        connectedUsers.delete(id);
      }
    } else {
      // Clean up dead connections
      connectedUsers.delete(id);
    }
  });
}

// WebSocket handling
wss.on('connection', (ws) => {
  console.log('New WebSocket connection established');

  let user = null;
  let userId = null;

  console.log(`New user connected. Total users: ${connectedUsers.size}`);

  // Send our identity back to the client holding that passcode, WITHOUT the passcode itself. if the password is correct they will have the same identity as before, if not, they will get a new identity.
  const GetUserFromPasscodeCookie = (passcode) => {
    if (passcode && userIdentities.has(passcode)) {
      const storedIdentity = userIdentities.get(passcode);
      userId = storedIdentity.id;
      user = {
        id: userId,
        username: storedIdentity.username,
        avatar: storedIdentity.avatar,
        clientId: storedIdentity.clientId,
        passcode: passcode,
        ws
      };
      connectedUsers.set(userId, user);
      // we can now send messages
      user.canSendMessages = true; // Allow sending messages after identity restoration
      userIdentities.set(passcode, {...storedIdentity, lastSeen: Date.now()});
      console.log(`Restored user identity: ${storedIdentity.username} (${userId}) with clientId: ${storedIdentity.clientId}`);
      // Send updated user info to client
      ws.send(JSON.stringify({
        type: 'restore-user',
        data: {
          user: {id: userId, username: user.username, avatar: user.avatar, clientId: user.clientId},
          onlineCount: connectedUsers.size
        }
      }));
      // Broadcast user connect to all clients
      broadcast({
        type: 'user-connected',
        data: {
          user: {id: userId, username: user.username, avatar: user.avatar, clientId: user.clientId},
          onlineCount: connectedUsers.size
        }
      });
    } else {
      // Create new user identity and save that password as its identifier
      // sanity check
      if (passcode && passcode.length < 5) {
        console.log(`Invalid passcode provided: ${passcode}`);
        ws.send(JSON.stringify({
          type: 'error',
          data: {message: 'Invalid passcode provided'}
        }));
        return;
      }

      userId = generateUserId();
      const username = generateUsername();
      const avatar = generateAvatar(username);
      const clientId = clientIdCounter++;
      user = {
        id: userId,
        username,
        avatar,
        clientId,
        passcode: passcode,
        ws,
        canSendMessages: true // Allow sending messages now that we have an identity
      };
      connectedUsers.set(userId, user);
      console.log(`New user created: ${username} (${userId}) with clientId: ${clientId}`);
      // Store user identity with passcode
      userIdentities.set(passcode, {
        id: userId,
        username,
        avatar,
        clientId,
        lastSeen: Date.now()
      });
      // Send user info to client WITHOUT their passcode
      ws.send(JSON.stringify({
        type: 'restore-user',
        data: {
          user: {id: userId, username, avatar, clientId},
          onlineCount: connectedUsers.size
        }
      }));
      console.log(`New user identity established: ${username} (${userId}) with clientId: ${clientId}`);
      // Broadcast new user connection to all clients
      broadcast({
        type: 'user-connected',
        data: {
          user: {id: userId, username, avatar, clientId},
          onlineCount: connectedUsers.size
        }
      });
    }

    // Now send all recent messages to the new user
    ws.send(JSON.stringify({
      type: 'recent-messages',
      data: {messages: messages.slice(-50)}
    }));

    return;
  };

  // Broadcast the new connection to others
  broadcast({
    type: 'user-connected',
    data: {onlineCount: connectedUsers.size}
  }, userId);

  // Send recent messages to new user - here we send them before they get an identity, which isn't secure and we can't know if they own the message
  /*ws.send(JSON.stringify({
    type: 'recent-messages',
    data: {messages: messages.slice(-50)}
  }));*/

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === 'restore-identity') {
        const {passcode: providedPasscode} = parsed.data;
        if (!providedPasscode || providedPasscode.length < 5) {
          console.log(`Invalid passcode provided for identity restoration: ${providedPasscode}`);
          ws.send(JSON.stringify({
            type: 'error',
            data: {message: 'Invalid passcode provided for identity restoration'}
          }));
          return;
        }
        GetUserFromPasscodeCookie(providedPasscode);
        return;
      }

      if (parsed.type === 'message') {
        // Verify passcode before allowing message, to match to a specific user. Then, check if the user is allowed to send messages
        if (!user || !user.passcode) {
          console.log(`Message rejected: User not authenticated`);
          return;
        }
        if (!userIdentities.has(user.passcode)) {
          console.log(`Message rejected: User passcode not found`);
          return;
        }
        if (!user.canSendMessages) {
          console.log(`Message rejected: User ${user.username} is not allowed to send messages`);
          return;
        }
        if (!parsed.data || !parsed.data.text) {
          console.log(`Message rejected: Invalid message format from ${user.username}`);
          return;
        }
        // Check if the passcode matches the user's passcode
        const {passcode: providedPasscode} = parsed.data;
        if (!providedPasscode || !userIdentities.has(providedPasscode) || user.passcode !== providedPasscode) {
          console.log(`Message rejected: Invalid passcode from ${user.username}`);
          return;
        }

        const filteredText = filterMessage(parsed.data.text);
        const messageData = {
          id: messageIdCounter++,
          username: user.username,
          avatar: user.avatar,
          clientId: user.clientId,
          text: filteredText,
          timestamp: new Date().toISOString(),
          reactions: {}
        };

        messages.push(messageData);

        console.log(`Broadcasting authenticated message from ${user.username} to ${connectedUsers.size} users`);

        // Broadcast message to all users including sender
        broadcastToAll({
          type: 'message',
          data: {message: messageData}
        });
      } else if (parsed.type === 'add-reaction') {
        // Verify passcode before allowing reaction
        const {messageId, emoji, passcode: providedPasscode} = parsed.data;
        if (!providedPasscode || !userIdentities.has(providedPasscode) || user.passcode !== providedPasscode) {
          console.log(`Reaction rejected: Invalid passcode from ${user.username}`);
          return;
        }

        const message = messages.find(m => m.id === parseInt(messageId));

        if (message && userId) {
          if (!message.reactions[emoji]) {
            message.reactions[emoji] = [];
          }

          // Toggle reaction (remove if exists, add if doesn't)
          const userIndex = message.reactions[emoji].indexOf(userId);
          if (userIndex > -1) {
            message.reactions[emoji].splice(userIndex, 1);
            if (message.reactions[emoji].length === 0) {
              delete message.reactions[emoji];
            }
          } else {
            // Remove user from other reactions for this message (one reaction per user)
            Object.keys(message.reactions).forEach(otherEmoji => {
              const idx = message.reactions[otherEmoji].indexOf(userId);
              if (idx > -1) {
                message.reactions[otherEmoji].splice(idx, 1);
                if (message.reactions[otherEmoji].length === 0) {
                  delete message.reactions[otherEmoji];
                }
              }
            });

            message.reactions[emoji].push(userId);
          }

          // Broadcast reaction update
          broadcast({
            type: 'reaction-added',
            data: {messageId: message.id, reactions: message.reactions}
          });
        }
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    const disconnectedUsername = user ? user.username : 'Unknown';
    console.log(`User ${disconnectedUsername} disconnected. Total users: ${connectedUsers.size - 1}`);
    connectedUsers.delete(userId);
    broadcast({
      type: 'user-disconnected',
      data: {onlineCount: connectedUsers.size}
    });
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    connectedUsers.delete(userId);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});