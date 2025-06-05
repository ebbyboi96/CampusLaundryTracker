const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const config = require("./config-example.json");

const webpush = require('web-push');
const PRIMARY_VANITY_URL_SR_CODE = 'W002023';

const DATA_LOG_FILE = path.join(__dirname, 'laundry_data_log.csv');
const CSV_HEADER = 'Timestamp,UTCDateTime,LocationID,RoomID,RoomName,MachineLabelID,MachineBTName,MachineType,LMCStatus,ReportedTimeRemaining\n';

const PORT = config.port || 3000;
const VAPID_PUBLIC_KEY = 'BDDLvJsttLO2_wqZpfv8CaZKX9ZCQT94WfznIYWseRtzTGnecEzo3CwGjBxuV2YfiOST8l5LcTNFEqpPg17rAbM';
const VAPID_PRIVATE_KEY = 'JzdoqtAC0s4SWdt-yEL36SUkSrasmWvvQ7thpISsFHc';

const KIOSOFT_WASHBOARD_BASE_URL = 'https://washboard.kiosoft.com:7005/api/vendors/';
let MAIN_APP_API_BASE_URL = '';
let MAIN_APP_X_API_KEY = 'co04ggk4ss8w4os8gk0480gwc4ssowwcg404s0sw';
let APP_CONFIG_VENDOR_ID = '';

let currentSrcCode = 'W002023';
let APP_CONFIG_CURRENT_LANGUAGE = '1';
let APP_CONFIG_LOCATION_ID = '';

let USER_ID = '';
let LOGIN_TOKEN = '';
let SERVER_VALUE_TOKEN = '';
const DEVICE_UUID = uuidv4();

const WASHBOARD_API_BASIC_AUTH_USER = 'ubix';
const WASHBOARD_API_BASIC_AUTH_PASS = 'u6ix1234';
const WASHBOARD_API_BASIC_AUTH_HEADER = `Basic ${Buffer.from(`${WASHBOARD_API_BASIC_AUTH_USER}:${WASHBOARD_API_BASIC_AUTH_PASS}`).toString('base64')}`;

const TEST_USER_EMAIL = config.email;
const TEST_USER_PASSWORD = config.password;

let locationDataStore = {};
const LOCATION_DATA_CACHE_TTL = 6 * 60 * 60 * 1000;


let locationDetailsCache = null;
let lastRoomStatusCache = {};
let isInitialized = false;
let pushSubscriptions = [];
let watchedMachines = {};

webpush.setVapidDetails(
    'https://www.campuslaundry.live',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    serverLog('debug', `Request received for: ${req.method} ${req.originalUrl}`);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    if (!res.headersSent) {
        serverLog('debug', `Request NOT handled by express.static: ${req.method} ${req.originalUrl}`);
    }
    next();
});

function logResponse(step, response) {
    console.log(`\n--- ${step} ---`);
    console.log('Status:', response.status, response.statusText);
    console.log('Data:', JSON.stringify(response.data, null, 2));
    console.log('---------------------\n');
}

function logError(step, error) {
    console.error(`\n--- ERROR in ${step} ---`);
    if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
        console.error('Request Error: No response received. Request details:', error.request);
    } else {
        console.error('Error Message:', error.message);
    }
    console.error('-------------------------\n');
}

function serverLog(level, message, data = null) {
    console[level](`[${new Date().toISOString()}] ${message}`, data || '');
}

function decodeHtmlEntities(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/&#039;/g, "'")
        .replace(/'/g, "'")
        .replace(/&/g, "&");
}

function simpleServerSideDecode(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, '"')
        .replace(/'/g, "'")
        .replace(/'/g, "'");
}

function createRoomSlug(roomName) {
    if (!roomName || typeof roomName !== 'string') {
        serverLog('debug', `[createRoomSlug] Invalid input: ${roomName}`);
        return null;
    }

    let slug = simpleServerSideDecode(roomName);

    slug = slug.toLowerCase()
        .trim()
        .replace(/&/g, 'and')
        .replace(/&/g, 'and')
        .replace(/'/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-');

    return slug;
}

function findRoomById(targetRoomId, roomsArray) {
    if (!roomsArray || !Array.isArray(roomsArray)) {
        serverLog('warn', 'findRoomById: roomsArray not available or not an array.');
        return null;
    }
    const numericTargetRoomId = parseInt(targetRoomId, 10);
    if (isNaN(numericTargetRoomId)) {
        serverLog('warn', `findRoomById: Invalid targetRoomId format: ${targetRoomId}`);
        return null;
    }
    for (const room of roomsArray) {
        if (room.id === numericTargetRoomId) {
            return room;
        }
    }
    serverLog('warn', `findRoomById: No room found for ID: '${numericTargetRoomId}'`);
    return null;
}

function findRoomBySlug(targetSlug, roomsArray) {
    if (!roomsArray || !Array.isArray(roomsArray)) {
        serverLog('warn', 'findRoomBySlug: roomsArray not available or not an array.');
        return null;
    }
    serverLog('info', `findRoomBySlug: Searching for target slug: '${targetSlug}'`);
    for (const room of roomsArray) {
        const originalRoomName = (typeof room.room_name === 'string') ? room.room_name : '';
        const generatedSlug = createRoomSlug(originalRoomName);
        serverLog('debug', `findRoomBySlug: Comparing '${targetSlug}' with generated slug '${generatedSlug}' (from room: '${originalRoomName}')`);
        if (generatedSlug === targetSlug) {
            return room;
        }
    }
    serverLog('warn', `findRoomBySlug: No room found for slug: '${targetSlug}'`);
    return null;
}

async function ensureLogFileExists() {
    try {
        await fs.access(DATA_LOG_FILE);
    } catch (error) {
        serverLog('info', `Log file ${DATA_LOG_FILE} not found, creating with header.`);
        try {
            await fs.writeFile(DATA_LOG_FILE, CSV_HEADER);
        } catch (writeError) {
            serverLog('error', 'Failed to create or write header to log file:', writeError);
        }
    }
}

function typeNameResolver(machineTypeString) {
    return machineTypeString.charAt(0).toUpperCase() + machineTypeString.slice(1);
}

async function getVendorIdFromKiosoft(srcCode, language) {
    const step = '1a. Get Vendor ID from Kiosoft';
    try {
        const response = await axios.get(`${KIOSOFT_WASHBOARD_BASE_URL}get_vendor_via_srcode`, {
            headers: { 'Authorization': WASHBOARD_API_BASIC_AUTH_HEADER, 'Cache-Control': 'no-cache' },
            params: { srcode: srcCode, language: language }
        });
        logResponse(step, response);
        if (response.data && response.data.vendor_id) {
            APP_CONFIG_VENDOR_ID = response.data.vendor_id;
            console.log(`APP_CONFIG_VENDOR_ID set to: ${APP_CONFIG_VENDOR_ID}`);
        } else {
            console.error(`${step}: Could not extract 'vendor_id'. Full data:`, response.data);
            throw new Error("Failed to get Vendor ID");
        }
        return response.data;
    } catch (error) {
        logError(step, error);
        throw error;
    }
}

async function getWashboardUrlsFromKiosoft(vendorId, language) {
    const step = '1b. Get Washboard URLs (Main Backend URL) from Kiosoft';
    if (!vendorId) throw new Error("Missing Vendor ID for getWashboardUrls");
    try {
        const response = await axios.get(`${KIOSOFT_WASHBOARD_BASE_URL}get_washboard_urls`, {
            headers: { 'Authorization': WASHBOARD_API_BASIC_AUTH_HEADER, 'Cache-Control': 'no-cache' },
            params: { vendor_id: vendorId, language: language }
        });
        logResponse(step, response);
        if (response.data && response.data.washboard_url && response.data.washboard_port) {
            MAIN_APP_API_BASE_URL = `${response.data.washboard_url}:${response.data.washboard_port}`;
            if (!MAIN_APP_API_BASE_URL.endsWith('/')) MAIN_APP_API_BASE_URL += '/';
            console.log(`MAIN_APP_API_BASE_URL set to: ${MAIN_APP_API_BASE_URL}`);
        } else {
            console.error(`${step}: Could not extract Washboard URL. Full data:`, response.data);
            throw new Error("Failed to get Main App Base URL");
        }
        return response.data;
    } catch (error) {
        logError(step, error);
        throw error;
    }
}

async function getWashboardApiKeyFromKiosoft(vendorId, language) {
    const step = '1c. Get Washboard API Key (X-API-KEY for Main API) from Kiosoft';
    if (!vendorId) throw new Error("Missing Vendor ID for getWashboardApiKey");
    try {
        const response = await axios.get(`${KIOSOFT_WASHBOARD_BASE_URL}get_washboard_api_key`, {
            headers: { 'Authorization': WASHBOARD_API_BASIC_AUTH_HEADER, 'Cache-Control': 'no-cache' },
            params: { vendor_id: vendorId, language: language }
        });
        logResponse(step, response);
        if (response.data && response.data.washboard_api_key) {
            MAIN_APP_X_API_KEY = response.data.washboard_api_key;
            console.log(`MAIN_APP_X_API_KEY dynamically set to: ${MAIN_APP_X_API_KEY}`);
        } else {
            console.log(`${step}: Could not extract 'washboard_api_key'. Using fallback: ${MAIN_APP_X_API_KEY}. Full data:`, response.data);
        }
        return response.data;
    } catch (error) {
        logError(step, error);
    }
}

async function getLocationDetailsForMainApi(srcCode, language) {
    const step = 'Backend: Get Location Details';
    if (!MAIN_APP_API_BASE_URL) {
        serverLog('error', `${step}: MAIN_APP_API_BASE_URL is not set.`);
        return null;
    }
    try {
        const response = await axios.get(`${MAIN_APP_API_BASE_URL}api/locations/get_location_via_srcode`, {
            headers: { 'X-API-KEY': MAIN_APP_X_API_KEY, 'Cache-Control': 'no-cache' },
            params: { srcode: srcCode, language: language }
        });
        serverLog('info', `${step} - Success`, response.status);
        if (response.data && response.data.location && response.data.location.location_id) {
            APP_CONFIG_LOCATION_ID = response.data.location.location_id;
            serverLog('info', `APP_CONFIG_LOCATION_ID set to: ${APP_CONFIG_LOCATION_ID}`);
        }
        locationDetailsCache = response.data;
        return response.data;
    } catch (error) {
        serverLog('error', `${step} - Failed`, error.message);
        return null;
    }
}

async function appUserSignIn(loginValue, passwordValue) {
    const step = '2. User Sign-In';
    if (!MAIN_APP_API_BASE_URL) {
        console.error(`${step}: MAIN_APP_API_BASE_URL is not set.`);
        throw new Error("MAIN_APP_API_BASE_URL not set for sign-in");
    }
    try {
        const payload = {
            login: loginValue,
            password: passwordValue,
            language: APP_CONFIG_CURRENT_LANGUAGE
        };
        console.log(`${step} - Payload:`, JSON.stringify(payload));
        const response = await axios.post(`${MAIN_APP_API_BASE_URL}api/auth/login`, payload, {
            headers: {
                'X-API-KEY': MAIN_APP_X_API_KEY,
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });
        logResponse(step, response);
        if (response.data) {
            USER_ID = response.data.user_id;
            LOGIN_TOKEN = response.data.token;
            console.log(`USER_ID set to: ${USER_ID}`);
            console.log(`LOGIN_TOKEN set to: ${LOGIN_TOKEN}`);
        } else {
            throw new Error("Sign-in response did not contain expected data.");
        }
        return response.data;
    } catch (error) {
        logError(step, error);
        throw error;
    }
}

async function getServerValueToken(userId, deviceUuid, loginToken, mainId = "") {
    const step = '3. Get Server Value Token';
    if (!MAIN_APP_API_BASE_URL) {
        console.error(`${step}: MAIN_APP_API_BASE_URL is not set.`);
        throw new Error("MAIN_APP_API_BASE_URL not set for getServerValueToken");
    }
    if (!userId || !loginToken) {
        console.error(`${step}: userId or loginToken is missing.`);
        throw new Error("Missing userId or loginToken for getServerValueToken");
    }
    try {
        const payload = {
            user_id: userId,
            uuid: deviceUuid,
            token: loginToken,
            main_id: mainId
        };
        console.log(`${step} - Payload:`, JSON.stringify(payload));
        const response = await axios.post(`${MAIN_APP_API_BASE_URL}api/token/get`, payload, {
            headers: {
                'X-API-KEY': MAIN_APP_X_API_KEY,
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            },
            timeout: 7000
        });
        logResponse(step, response);
        if (response.data && response.data.token) {
            SERVER_VALUE_TOKEN = response.data.token;
            console.log(`SERVER_VALUE_TOKEN set to: ${SERVER_VALUE_TOKEN}`);
        } else {
            console.warn(`${step}: Could not extract 'token' for SERVER_VALUE_TOKEN. Full data:`, response.data);
        }
        return response.data;
    } catch (error) {
        logError(step, error);
        throw error;
    }
}

async function getRoomStatus(roomId, tokenToUse) {
    const step = `Backend: Get Room Status for ${roomId}`;
    if (!MAIN_APP_API_BASE_URL) { serverLog('error', `${step}: MAIN_APP_API_BASE_URL missing.`); return null; }
    if (!roomId) { serverLog('error', `${step}: roomId missing.`); return null; }
    if (!tokenToUse) { serverLog('error', `${step}: tokenToUse missing.`); return null; }

    try {
        const response = await axios.get(`${MAIN_APP_API_BASE_URL}api/rooms/status`, {
            headers: {
                'X-API-KEY': MAIN_APP_X_API_KEY,
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            },
            params: { room_id: roomId, token: tokenToUse }
        });
        serverLog('info', `${step} - Success`, response.status);
        lastRoomStatusCache[roomId] = { data: response.data, timestamp: Date.now() };
        return response.data;
    } catch (error) {
        serverLog('error', `${step} - Failed: Status ${error.response?.status}`, error.response?.data || error.message);
        return null;
    }
}

async function checkAndSendNotifications(machineData, machineType, roomDetails) {
    const machineBTName = machineData.BTName;
    if (!machineBTName || !watchedMachines[machineBTName]) {
        return;
    }

    const watchInfo = watchedMachines[machineBTName];
    const remainingMin = parseInt(machineData.RemainingMin, 10);
    const lmcStatus = machineData.LMCStatus;

    if (lmcStatus === "51000000" && !isNaN(remainingMin) && remainingMin > 0 && remainingMin <= 5) {
        if (!watchInfo.notifiedEnding) {
            const payload = JSON.stringify({
                title: 'Laundry Cycle Ending Soon!',
                body: `${typeNameResolver(machineType)} ${machineData.LabelID} in ${roomDetails.roomName} has about ${remainingMin} min left.`,
            });

            serverLog('info', `Sending "ending soon" notification for ${machineBTName} to ${watchInfo.subscription.endpoint}`);
            try {
                await webpush.sendNotification(watchInfo.subscription, payload);
                watchInfo.notifiedEnding = true;
                watchedMachines[machineBTName] = watchInfo;
            } catch (error) {
                serverLog('error', `Error sending push notification for ${machineBTName}:`, error.message);
                if (error.statusCode === 404 || error.statusCode === 410) {
                    serverLog('warn', `Subscription for ${machineBTName} seems to be invalid. Removing.`);
                    delete watchedMachines[machineBTName];
                    pushSubscriptions = pushSubscriptions.filter(sub => sub.endpoint !== watchInfo.subscription.endpoint);
                }
            }
        }
    } else if (lmcStatus !== "51000000" || (isNaN(remainingMin) || remainingMin === 0)) {
        if (watchInfo.notifiedEnding) {
            serverLog('info', `Resetting 'notifiedEnding' for ${machineBTName} as cycle state changed.`);
            watchInfo.notifiedEnding = false;
            watchedMachines[machineBTName] = watchInfo;
        }
    }
}

async function initializeApp(srcCodeToUse) {
    serverLog('info', `INIT: Attempting for SRC Code: ${srcCodeToUse}. Current server SR: ${currentSrcCode}, Initialized: ${isInitialized}`);

    const previousSrcCode = currentSrcCode;
    const previousIsInitialized = isInitialized;
    const prevVendorId = APP_CONFIG_VENDOR_ID;
    const prevBaseUrl = MAIN_APP_API_BASE_URL;
    const prevApiKey = MAIN_APP_X_API_KEY;
    const prevLocationId = APP_CONFIG_LOCATION_ID;
    const prevUserId = USER_ID;
    const prevLoginToken = LOGIN_TOKEN;

    if (locationDataStore[srcCodeToUse] && (Date.now() - locationDataStore[srcCodeToUse].cachedAt < LOCATION_DATA_CACHE_TTL)) {
        serverLog('info', `INIT: Cache HIT and FRESH for ${srcCodeToUse}.`);
        const cachedData = locationDataStore[srcCodeToUse];

        APP_CONFIG_VENDOR_ID = cachedData.vendorId;
        MAIN_APP_API_BASE_URL = cachedData.mainAppApiBaseUrl;
        MAIN_APP_X_API_KEY = cachedData.apiKey;
        APP_CONFIG_LOCATION_ID = cachedData.locationDetails.location.location_id;

        currentSrcCode = srcCodeToUse;

        if (!USER_ID || !LOGIN_TOKEN) {
            try {
                serverLog('info', `INIT (Cache): Performing user sign-in as tokens are missing for ${currentSrcCode}.`);
                await appUserSignIn(TEST_USER_EMAIL, TEST_USER_PASSWORD);
            } catch (signInError) {
                serverLog('error', `INIT (Cache): User sign-in FAILED for ${currentSrcCode}. Error: ${signInError.message}`);
                currentSrcCode = previousSrcCode;
                isInitialized = previousIsInitialized;
                APP_CONFIG_VENDOR_ID = prevVendorId;
                MAIN_APP_API_BASE_URL = prevBaseUrl;
                MAIN_APP_X_API_KEY = prevApiKey;
                APP_CONFIG_LOCATION_ID = prevLocationId;
                USER_ID = prevUserId;
                LOGIN_TOKEN = prevLoginToken;
                return { success: false, message: `Sign-in failed while using cached data for ${srcCodeToUse}.`, locationDetails: null };
            }
        }

        isInitialized = true;
        serverLog('info', `INIT: SUCCESS using CACHED data for SRC Code: ${currentSrcCode}. Location: ${cachedData.locationDetails.location.location_name}`);
        return { success: true, message: 'Initialization successful from cache', locationDetails: cachedData.locationDetails };
    }

    serverLog('info', `INIT: Cache MISS or STALE for ${srcCodeToUse}. Fetching fresh data.`);
    isInitialized = false;

    try {
        await getVendorIdFromKiosoft(srcCodeToUse, APP_CONFIG_CURRENT_LANGUAGE);
        await getWashboardUrlsFromKiosoft(APP_CONFIG_VENDOR_ID, APP_CONFIG_CURRENT_LANGUAGE);
        await getWashboardApiKeyFromKiosoft(APP_CONFIG_VENDOR_ID, APP_CONFIG_CURRENT_LANGUAGE);

        currentSrcCode = srcCodeToUse;
        if (!USER_ID || !LOGIN_TOKEN) {
            serverLog('info', `INIT (Fresh): Performing user sign-in for ${currentSrcCode}.`);
            await appUserSignIn(TEST_USER_EMAIL, TEST_USER_PASSWORD);
        }

        const locDetails = await getLocationDetailsForMainApi(currentSrcCode, APP_CONFIG_CURRENT_LANGUAGE);

        if (!locDetails || !locDetails.location || !locDetails.location.location_id || !locDetails.rooms) {
            throw new Error(`Incomplete location details received for ${currentSrcCode}.`);
        }
        APP_CONFIG_LOCATION_ID = locDetails.location.location_id;

        isInitialized = true;

        locationDataStore[currentSrcCode] = {
            vendorId: APP_CONFIG_VENDOR_ID,
            mainAppApiBaseUrl: MAIN_APP_API_BASE_URL,
            apiKey: MAIN_APP_X_API_KEY,
            locationDetails: locDetails,
            cachedAt: Date.now()
        };

        serverLog('info', `INIT: SUCCESS (Fresh) for SRC Code: ${currentSrcCode}! Data cached. Location: ${locDetails.location.location_name}, Rooms: ${locDetails.rooms.length}`);
        return { success: true, message: 'Initialization successful with fresh data', locationDetails: locDetails };

    } catch (error) {
        serverLog('error', `INIT: FAILED for SRC Code ${srcCodeToUse}: ${error.message}`);
        currentSrcCode = previousSrcCode;
        isInitialized = previousIsInitialized;
        APP_CONFIG_VENDOR_ID = prevVendorId;
        MAIN_APP_API_BASE_URL = prevBaseUrl;
        MAIN_APP_X_API_KEY = prevApiKey;
        APP_CONFIG_LOCATION_ID = prevLocationId;
        USER_ID = prevUserId;
        LOGIN_TOKEN = prevLoginToken;

        serverLog('info', `INIT: Reverted to previous server state. SR: ${currentSrcCode}, Initialized: ${isInitialized}`);
        return { success: false, message: error.message || `Initialization failed for ${srcCodeToUse}`, locationDetails: null };
    }
}

async function collectAllRoomData() {
    if (!isInitialized || !locationDetailsCache || !locationDetailsCache.rooms) {
        serverLog('warn', 'Data collection skipped: App not initialized or no rooms.');
        return;
    }
    serverLog('info', 'Starting data collection cycle...');
    const collectionTimestamp = new Date();
    const utcDateTime = collectionTimestamp.toISOString();

    let csvEntries = '';

    for (const room of locationDetailsCache.rooms) {
        const roomIdToFetch = room.id;
        serverLog('info', `Collecting data for room: ${room.room_name} (ID: ${roomIdToFetch})`);
        const statusData = await getRoomStatus(roomIdToFetch, LOGIN_TOKEN);

        const roomDetailsForNotification = { id: room.id, roomName: room.room_name };

        if (statusData && statusData.washers) {
            statusData.washers.forEach(washer => {
                checkAndSendNotifications(washer, 'Washer', roomDetailsForNotification);
            });
        }
        if (statusData && statusData.dryers) {
            statusData.dryers.forEach(dryer => {
                checkAndSendNotifications(dryer, 'Dryer', roomDetailsForNotification);
            });
        }
        await new Promise(resolve => setTimeout(resolve, 250));

        const processMachines = (machines, machineType) => {
            if (statusData && machines) {
                machines.forEach(machine => {
                    const roomNameSafe = room.room_name.replace(/,|"/g, '');
                    const machineLabelSafe = machine.LabelID.replace(/,|"/g, '');
                    const machineBtNameSafe = machine.BTName ? machine.BTName.replace(/,|"/g, '') : 'N/A';

                    csvEntries += `${collectionTimestamp.toLocaleString()},${utcDateTime},${APP_CONFIG_LOCATION_ID || 'N/A'},${roomIdToFetch},"${roomNameSafe}","${machineLabelSafe}","${machineBtNameSafe}",${machineType},${machine.LMCStatus || 'N/A'},${machine.RemainingMin || '0'}\n`;
                });
            }
        };

        processMachines(statusData?.washers, 'washer');
        processMachines(statusData?.dryers, 'dryer');

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (csvEntries.length > 0) {
        try {
            await fs.appendFile(DATA_LOG_FILE, csvEntries);
            serverLog('info', `Data collection cycle finished. ${csvEntries.split('\n').length -1} entries appended to ${DATA_LOG_FILE}`);
        } catch (error) {
            serverLog('error', 'Failed to append data to log file:', error);
        }
    } else {
        serverLog('info', 'Data collection cycle finished. No new machine data to log.');
    }
}





let collectedData = [];


app.post('/api/set-location', async (req, res) => {
    const { srcCode } = req.body;
    if (!srcCode || typeof srcCode !== 'string' || srcCode.trim() === '') {
        return res.status(400).json({ error: 'Invalid srcCode provided.' });
    }

    serverLog('info', `Received request to set location with SRC Code: ${srcCode}`);
    const initResult = await initializeApp(srcCode.trim());

    if (initResult.success) {
        const rooms = (initResult.locationDetails && initResult.locationDetails.rooms)
            ? initResult.locationDetails.rooms.map(room => ({
                id: room.id,
                name: room.room_name,
            }))
            : [];

        res.json({
            success: true,
            message: `Location set to ${srcCode}`,
            rooms: rooms,
            locationDetails: initResult.locationDetails
        });
    } else {
        res.status(500).json({
            error: 'Failed to initialize with new location code.',
            details: initResult.message
        });
    }
});

app.get('/api/rooms', async (req, res) => {
    if (!isInitialized) {
        return res.status(503).json({ error: 'Service not initialized. Please try again later.' });
    }
    if (locationDetailsCache && locationDetailsCache.rooms) {
        const rooms = locationDetailsCache.rooms.map(room => ({
            id: room.id,
            name: room.room_name,
            locationSpecificRoomId: room.room_id
        }));
        res.json(rooms);
    } else {
        res.status(404).json({ error: 'Room information not available.' });
    }
});

app.get('/api/room/:roomId/status', async (req, res) => {
    if (!isInitialized) {
        return res.status(503).json({ error: 'Service not initialized. Please try again later.' });
    }
    const { roomId } = req.params;
    if (!LOGIN_TOKEN) {
        return res.status(401).json({ error: 'Authentication token not available.' });
    }
    const statusData = await getRoomStatus(roomId, LOGIN_TOKEN);
    if (statusData) {
        res.json(statusData);
    } else {
        res.status(404).json({ error: `Could not get status for room ${roomId}. Check server logs.` });
    }
});

app.post('/api/subscribe-notifications', (req, res) => {
    const subscription = req.body.subscription;
    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: 'Invalid subscription object provided.' });
    }

    if (!pushSubscriptions.find(sub => sub.endpoint === subscription.endpoint)) {
        pushSubscriptions.push(subscription);
        serverLog('info', 'New push subscription received and stored:', subscription.endpoint);
    } else {
        serverLog('info', 'Push subscription already exists:', subscription.endpoint);
    }
    res.status(201).json({ message: 'Subscription received.' });
});

app.post('/api/watch-machine', (req, res) => {
    const { machineBTName, subscriptionEndpoint } = req.body;

    if (!machineBTName || !subscriptionEndpoint) {
        return res.status(400).json({ error: 'machineBTName and subscriptionEndpoint are required.' });
    }

    const subscription = pushSubscriptions.find(sub => sub.endpoint === subscriptionEndpoint);
    if (!subscription) {
        return res.status(404).json({ error: 'Subscription not found. Please subscribe to notifications first.' });
    }

    watchedMachines[machineBTName] = {
        subscription: subscription,
        notifiedEnding: false,
    };
    serverLog('info', `Machine ${machineBTName} is now being watched by ${subscriptionEndpoint}`);
    res.status(200).json({ message: `Now watching machine ${machineBTName}.` });
});

app.post('/api/unwatch-machine', (req, res) => {
    const { machineBTName } = req.body;
    if (!machineBTName) {
        return res.status(400).json({ error: 'machineBTName is required.' });
    }
    if (watchedMachines[machineBTName]) {
        delete watchedMachines[machineBTName];
        serverLog('info', `Machine ${machineBTName} is no longer being watched.`);
        res.status(200).json({ message: `No longer watching machine ${machineBTName}.` });
    } else {
        res.status(404).json({ message: `Machine ${machineBTName} was not being watched.` });
    }
});

function findRoomById(targetRoomIdAsNumber, roomsArray) {
    if (!roomsArray || !Array.isArray(roomsArray)) {
        serverLog('warn', 'findRoomById: roomsArray is null or not an array.');
        return null;
    }
    if (typeof targetRoomIdAsNumber !== 'number' || isNaN(targetRoomIdAsNumber)) {
        serverLog('error', `findRoomById: targetRoomIdAsNumber is not a valid number: ${targetRoomIdAsNumber}`);
        return null;
    }

    serverLog('debug', `findRoomById: Searching for target numeric Room ID: ${targetRoomIdAsNumber} in ${roomsArray.length} rooms.`);
    for (const room of roomsArray) {
        const roomIdFromCache = room.id;
        const typeOfRoomIdFromCache = typeof roomIdFromCache;

        if (typeOfRoomIdFromCache === 'number') {
            if (roomIdFromCache === targetRoomIdAsNumber) {
                serverLog('info', `findRoomById: MATCH (number to number) for ID ${targetRoomIdAsNumber} -> Room: '${room.room_name}'`);
                return room;
            }
        } else if (typeOfRoomIdFromCache === 'string') {
            const numericRoomIdFromCache = parseInt(roomIdFromCache, 10);
            if (!isNaN(numericRoomIdFromCache) && numericRoomIdFromCache === targetRoomIdAsNumber) {
                serverLog('info', `findRoomById: MATCH (string parsed to number) for ID ${targetRoomIdAsNumber} (cache ID was string "${roomIdFromCache}") -> Room: '${room.room_name}'`);
                return room;
            }
        } else {
            serverLog('warn', `findRoomById: Room '${room.room_name}' has an unexpected ID type or unparseable ID string: ${roomIdFromCache} (type: ${typeOfRoomIdFromCache})`);
        }
    }
    serverLog('warn', `findRoomById: No room found for numeric ID: ${targetRoomIdAsNumber} after checking all rooms.`);
    return null;
}

app.get('/:srcCodeParam/:roomIdentifierParam', async (req, res, next) => {
    const srcCodeFromUrl = req.params.srcCodeParam.toUpperCase();
    const roomIdentifierFromUrl = req.params.roomIdentifierParam;

    serverLog('info', `VANITY: Request /${srcCodeFromUrl}/${roomIdentifierFromUrl}. Server SR: '${currentSrcCode}', Init: ${isInitialized}`);

    if (!/^[A-Z0-9]{7}$/.test(srcCodeFromUrl)) {
        serverLog('warn', `VANITY: Invalid SR Code format: ${srcCodeFromUrl}.`);
        return next();
    }

    if (!isInitialized || currentSrcCode !== srcCodeFromUrl) {
        serverLog('info', `VANITY: Re-init needed. Req: ${srcCodeFromUrl}, Curr: ${currentSrcCode}, Init: ${isInitialized}`);
        const initResult = await initializeApp(srcCodeFromUrl);
        if (!initResult.success) {
            serverLog('error', `VANITY: Re-init FAILED for ${srcCodeFromUrl}. Msg: ${initResult.message}`);
            return res.status(503).send(`Service error: Could not load data for location code ${srcCodeFromUrl}.`);
        }
        serverLog('info', `VANITY: Re-init for ${srcCodeFromUrl} SUCCESS. Server SR now: '${currentSrcCode}'.`);
    } else {
        serverLog('info', `VANITY: No re-init needed for ${currentSrcCode}.`);
    }

    if (!locationDetailsCache || !locationDetailsCache.rooms) {
        serverLog('error', `VANITY: CRITICAL - No room data in cache for ${currentSrcCode} after init.`);
        const emergencyInitResult = await initializeApp(currentSrcCode);
        if (!emergencyInitResult.success || !locationDetailsCache || !locationDetailsCache.rooms) {
            serverLog('error', `VANITY: Emergency re-init also FAILED for ${currentSrcCode}.`);
            return res.status(500).send(`Internal error: Room data unavailable for ${currentSrcCode}.`);
        }
        serverLog('warn', `VANITY: Emergency re-init was performed for ${currentSrcCode}. This indicates a potential state issue.`);
    }

    serverLog('debug', `VANITY: Searching in cache for SR: ${currentSrcCode}. Rooms available: ${locationDetailsCache.rooms.length}`);
    if (locationDetailsCache.rooms.length > 0) {
        serverLog('debug', `VANITY: First few room IDs in cache: ${locationDetailsCache.rooms.slice(0,5).map(r => `${r.id} (type: ${typeof r.id})` ).join(', ')}`);
    }


    let room = null;
    if (/^\d+$/.test(roomIdentifierFromUrl)) {
        const roomIdToFind = parseInt(roomIdentifierFromUrl, 10);
        serverLog('debug', `VANITY: Identifier '${roomIdentifierFromUrl}' is numeric. Parsed ID to find: ${roomIdToFind} (type: number).`);
        room = findRoomById(roomIdToFind, locationDetailsCache.rooms);
    } else {
        const slugToSearch = roomIdentifierFromUrl.toLowerCase();
        serverLog('debug', `VANITY: Identifier '${roomIdentifierFromUrl}' not numeric. Trying findRoomBySlug for '${slugToSearch}'.`);
        room = findRoomBySlug(slugToSearch, locationDetailsCache.rooms);
    }

    const payloadForClient = {
        targetRoomId: null,
        targetRoomName: null,
        currentSRCode: currentSrcCode,
        locationDetails: locationDetailsCache
    };

    if (room) {
        serverLog('info', `VANITY: MATCH! Found room: ID ${room.id} (type: ${typeof room.id}), Name: '${room.room_name}' in ${currentSrcCode}`);
        payloadForClient.targetRoomId = room.id;
        payloadForClient.targetRoomName = room.room_name;
    } else {
        serverLog('warn', `VANITY: Room identifier '${roomIdentifierFromUrl}' NOT FOUND in ${currentSrcCode}. Client will show room list.`);
    }

    try {
        const htmlData = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
        serverLog('debug', '[VANITY] Injecting client payload:', payloadForClient);
        const modifiedHtml = htmlData.replace(
            '<script id="initial-room-data" type="application/json"></script>',
            `<script id="initial-room-data" type="application/json">${JSON.stringify(payloadForClient)}</script>`
        );
        res.setHeader('Content-Type', 'text/html');
        res.send(modifiedHtml);
    } catch (err) {
        serverLog('error', 'VANITY: Failed to read/send index.html:', err);
        res.status(500).send('Error preparing page content.');
    }
});


app.use((req, res, next) => {
    if (req.method === 'GET' && !res.headersSent &&
        (req.accepts('html') || req.path === '/')) {

        if (req.path.startsWith('/api/')) {
            serverLog('debug', `SPA Catch-all: Path ${req.path} looks like API, passing.`);
            return next();
        }

        serverLog('info', `SPA Catch-all: Attempting to serve index.html for GET path: ${req.path}`);
        const indexPath = path.join(__dirname, 'public', 'index.html');

        fs.access(indexPath)
            .then(() => {
                res.sendFile(indexPath, (err) => {
                    if (err) {
                        serverLog('error', `SPA Catch-all: Error sending index.html for ${req.path}`, err);
                        if (!res.headersSent) {
                            next(err);
                        }
                    } else {
                        serverLog('info', `SPA Catch-all: Successfully sent index.html for ${req.path}`);
                    }
                });
            })
            .catch(err => {
                serverLog('error', `SPA Catch-all: index.html not accessible at ${indexPath}`, err);
                if (!res.headersSent) {
                    res.status(500).send('Main application file is missing.');
                }
            });
    } else {
        if (req.method === 'GET' && !res.headersSent) {
            serverLog('debug', `SPA Catch-all: Conditions not met for ${req.method} ${req.path} (Accepts: ${req.headers.accept})`);
        }
        next();
    }
});


app.use((req, res, next) => {
    if (!res.headersSent) {
        serverLog('warn', `Final 404: Route not found - ${req.method} ${req.originalUrl}`);
        res.status(404).send("Sorry, the page you are looking for doesn't exist.");
    }
});

app.use((err, req, res, next) => {
    serverLog('error', 'Unhandled Express Error:', err.stack || err.message || err);
    if (!res.headersSent) {
        res.status(500).send('Something broke on the server!');
    }
});


app.listen(PORT, async () => {
    serverLog('info', `Backend server running on http://localhost:${PORT}`);
    await ensureLogFileExists();
    await initializeApp(currentSrcCode);
});