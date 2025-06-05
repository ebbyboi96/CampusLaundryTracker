const API_BASE_URL = '';
const srCodeSetupEl = document.getElementById('sr-code-setup');
const srCodeInputEl = document.getElementById('sr-code-input');
const submitSrCodeBtn = document.getElementById('submit-sr-code-btn');
const srCodeErrorEl = document.getElementById('sr-code-error');
const currentSrCodeDisplayEl = document.getElementById('current-sr-code-display');
const changeLocationBtn = document.getElementById('change-location-btn');
const pageTitleEl = document.querySelector('title');
const mainHeaderTitleEl = document.querySelector('header h1');

const roomListEl = document.getElementById('room-list');
const roomSelectionEl = document.getElementById('room-selection');
const machineStatusSectionEl = document.getElementById('machine-status-section');
const currentRoomNameEl = document.getElementById('current-room-name');
const washersListEl = document.getElementById('washers-list');
const dryersListEl = document.getElementById('dryers-list');
const toggleRoomsBtn = document.getElementById('toggle-rooms-btn');

let swRegistration = null;
let isSubscribed = false;
let currentPushSubscription = null;

let currentRoomId = null;
let statusIntervalId = null;
let currentSelectedSRCode = localStorage.getItem('laundrySRCode');

let initialTargetRoomId = null;
let initialTargetRoomName = null;
let initialSRCodeFromServer = null;

const VAPID_PUBLIC_KEY = 'BDDLvJsttLO2_wqZpfv8CaZKX9ZCQT94WfznIYWseRtzTGnecEzo3CwGjBxuV2YfiOST8l5LcTNFEqpPg17rAbM';

let lastRoomStatusCache = {};

const LMC_STATUS_CODES = {
    "00000000": { text: "Available", class: "status-available", showTime: false },
    "41000000": { text: "Transition", class: "status-ending", showTime: true },
    "42000000": { text: "In Use", class: "status-in-use", showTime: true },
    "51000000": { text: "In Use", class: "status-in-use", showTime: true },
    "52000000": { text: "Finishing Cycle", class: "status-ending", showTime: true },
    "71000000": { text: "Cycle Complete", class: "status-available", showTime: false },
    "72000000": { text: "Cycle Complete", class: "status-available", showTime: false },
    "61000000": { text: "Machine Error", class: "status-out-of-order", showTime: false },
    "UNKNOWN": { text: "Status Unknown", class: "", showTime: false }
};

function clientCreateRoomIdentifier(room) {
    return room.id.toString();
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function updatePageAndHeaderTitle(locationName) {
    const baseTitle = "Laundry Room Status";
    const decodedLocationName = decodeHtmlEntities(locationName);

    if (decodedLocationName && decodedLocationName.trim() !== '') {
        const newTitle = `${baseTitle} - ${decodedLocationName}`;
        if (pageTitleEl) pageTitleEl.textContent = newTitle;
        if (mainHeaderTitleEl) mainHeaderTitleEl.textContent = newTitle;
    } else {
        if (pageTitleEl) pageTitleEl.textContent = baseTitle;
        if (mainHeaderTitleEl) mainHeaderTitleEl.textContent = baseTitle;
    }
}

async function registerServiceWorkerAndSubscribe() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        console.log('Service Worker and Push is supported');

        try {
            swRegistration = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker is registered', swRegistration);
            const existingSubscription = await swRegistration.pushManager.getSubscription();
            if (existingSubscription) {
                console.log('User IS already subscribed.');
                isSubscribed = true;
                currentPushSubscription = existingSubscription;
            } else {
                console.log('User is NOT subscribed.');
                isSubscribed = false;
            }

        } catch (error) {
            console.error('Service Worker Error', error);
        }
    } else {
        console.warn('Push messaging is not supported');
    }
}

async function subscribeUserToPush() {
    if (!swRegistration) {
        console.error('Service worker not registered.');
        return null;
    }
    try {
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        const subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey
        });
        console.log('User is subscribed:', subscription);
        isSubscribed = true;
        currentPushSubscription = subscription;
        await sendSubscriptionToBackend(subscription);
        return subscription;
    } catch (err) {
        console.error('Failed to subscribe the user: ', err);
        if (Notification.permission === 'denied') {
            alert('Notification permission was denied. Please enable it in your browser settings.');
        }
        return null;
    }
}

async function sendSubscriptionToBackend(subscription) {
    try {
        const response = await fetch('/api/subscribe-notifications', {
            method: 'POST',
            body: JSON.stringify({ subscription: subscription }),
            headers: {
                'content-type': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error('Bad status code from server.');
        }
        console.log('Subscription sent to backend successfully.');
    } catch (error) {
        console.error('Error sending subscription to backend: ', error);
    }
}

async function requestNotificationPermissionAndSubscribe() {
    const permissionResult = await Notification.requestPermission();
    if (permissionResult === 'granted') {
        console.log('Notification permission granted.');
        return subscribeUserToPush();
    } else {
        console.log('Notification permission not granted.');
        alert('Notifications will not be sent as permission was not granted.');
        return null;
    }
}

function getDisplayStatus(lmcStatus, idleFlag, remainingMinStr, typeName) {
    let statusKey = lmcStatus;
    let statusInfo = { ...LMC_STATUS_CODES[statusKey] };
    const remainingMin = parseInt(remainingMinStr, 10);

    if (!LMC_STATUS_CODES[statusKey]) {
        statusInfo = { ...LMC_STATUS_CODES["UNKNOWN"] };
        if (idleFlag === "1") {
            return { ...LMC_STATUS_CODES["00000000"], text: "Available", originalCode: lmcStatus };
        }
        return { ...statusInfo, text: `Status: ${lmcStatus || 'N/A'}`, showTime: (remainingMin > 0) };
    }

    if (lmcStatus === "41000000") {
        if (idleFlag === "1") {
            statusInfo.text = typeName === "Washer" ? "Wash Cycle Ended" : "Dry Cycle Ended";
            statusInfo.class = "status-available";
            statusInfo.showTime = false;
        } else if (!isNaN(remainingMin)) {
            if (remainingMin > 30) {
                statusInfo.text = typeName === "Washer" ? "Cycle Starting" : "Warming Up";
                statusInfo.class = "status-in-use";
                statusInfo.showTime = true;
            } else if (remainingMin > 0 && remainingMin <= 30) {
                statusInfo.text = typeName === "Washer" ? "Cycle Ending" : "Cooling Down";
                statusInfo.class = "status-ending";
                statusInfo.showTime = true;
            } else {
                statusInfo.text = typeName === "Washer" ? "Washer Ready" : "Dryer Ready";
                statusInfo.class = "status-available";
                statusInfo.showTime = false;
            }
        } else {
            statusInfo.text = `${typeName} Transitioning`;
            statusInfo.class = "status-ending";
            statusInfo.showTime = false;
        }
    }
    else if ((lmcStatus === "71000000" || lmcStatus === "72000000") && idleFlag === "0") {
        statusInfo.text = typeName === "Washer" ? "Wash Complete (Check Door)" : "Dry Complete (Check Door)";
        statusInfo.showTime = false;
    }

    if (statusInfo.showTime && (isNaN(remainingMin) || remainingMin <= 0)) {
        statusInfo.showTime = false;
    }

    return { ...statusInfo, originalCode: lmcStatus };
}

function createNotifyButton(machine, typeName, machineLabel, uniqueId) {
    const notifyBtn = document.createElement('button');
    notifyBtn.classList.add('notify-btn');

    const machineIdentifierForWatch = machine.BTName || uniqueId;
    notifyBtn.dataset.machineBtname = machineIdentifierForWatch;
    notifyBtn.dataset.machineLabel = machineLabel;

    const currentRoomNameText = currentRoomNameEl.textContent || '';
    notifyBtn.dataset.roomName = decodeHtmlEntities(currentRoomNameText.replace('Status for: ', '').trim());

    const isWatching = localStorage.getItem(`watching_${machineIdentifierForWatch}`) === 'true';
    notifyBtn.textContent = isWatching ? 'Stop Watching' : 'Notify Me';
    if (isWatching) {
        notifyBtn.classList.add('watching');
    }

    notifyBtn.addEventListener('click', handleNotifyMeClick);
    return notifyBtn;
}

function decodeHtmlEntities(text) {
    if (text === null || typeof text === 'undefined') return '';
    let decodedText = text;
    let previousText = '';

    for (let i = 0; i < 5 && decodedText !== previousText; i++) {
        previousText = decodedText;
        decodedText = decodedText.replace(/&#039;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&/g, "&")
            .replace(/'/g, "'")
            .replace(/"/g, '"')
            .replace(/</g, '<')
            .replace(/>/g, '>');

        const textArea = document.createElement('textarea');
        textArea.innerHTML = decodedText;
        decodedText = textArea.value;
    }
    return decodedText;
}

let initialPageLoadData = null;

function parseInitialRoomData() {
    const dataScript = document.getElementById('initial-room-data');
    if (dataScript && dataScript.textContent) {
        try {
            const data = JSON.parse(dataScript.textContent);
            initialTargetRoomId = data.targetRoomId;
            initialTargetRoomName = data.targetRoomName;
            initialSRCodeFromServer = data.currentSRCode;
            initialPageLoadData = data;
            console.log('Initial room data from server:', data);
        } catch (e) {
            console.error('Error parsing initial room data:', e);
            initialPageLoadData = null;
        }
    }
}

function displayRooms(rooms) {
    roomListEl.innerHTML = '';
    if (rooms && Array.isArray(rooms) && rooms.length > 0) {
        rooms.forEach(room => {
            const li = document.createElement('li');
            const rawRoomNameFromApi = room.name;
            const fullyDecodedRoomName = decodeHtmlEntities(rawRoomNameFromApi);
            li.textContent = fullyDecodedRoomName;
            li.dataset.roomId = room.id;
            li.dataset.roomName = fullyDecodedRoomName;
            li.addEventListener('click', handleRoomSelection);
            roomListEl.appendChild(li);
        });
        roomSelectionEl.style.display = 'block';
        machineStatusSectionEl.style.display = 'none';
        srCodeSetupEl.style.display = 'none';
        if (toggleRoomsBtn) toggleRoomsBtn.style.display = 'inline-block';
        if (toggleRoomsBtn) toggleRoomsBtn.textContent = 'Hide Room List';
    } else {
        roomListEl.innerHTML = '<li>No rooms found for this location or an error occurred. Try changing the location code.</li>';
        roomSelectionEl.style.display = 'block';
        machineStatusSectionEl.style.display = 'none';
        if (toggleRoomsBtn) toggleRoomsBtn.style.display = 'none';
    }
}

async function setLocationAndFetchRooms(srCode, isVanityUrlLoad = false) {
    const trimmedSrCode = srCode.trim().toUpperCase();
    if (!isVanityUrlLoad) {
        updatePageAndHeaderTitle('Loading Location...');
    }
    if (!trimmedSrCode || trimmedSrCode.length !== 7 || !/^[A-Z0-9]{7}$/.test(trimmedSrCode)) {
        srCodeErrorEl.textContent = 'Please enter a valid 7-character alphanumeric location code (e.g., W002023).';
        srCodeErrorEl.style.display = 'block';
        if (roomListEl) roomListEl.innerHTML = '';
        if (roomSelectionEl) roomSelectionEl.style.display = 'block';
        updatePageAndHeaderTitle('');
        return { success: false, rooms: [], locationDetails: null };
    }

    srCodeErrorEl.style.display = 'none';
    if (submitSrCodeBtn) submitSrCodeBtn.disabled = true;
    if (submitSrCodeBtn) submitSrCodeBtn.textContent = 'Loading...';
    if (roomSelectionEl) roomSelectionEl.style.display = 'block';
    if (roomListEl) roomListEl.innerHTML = '<li class="loading">Setting location and fetching rooms...</li>';
    if (machineStatusSectionEl) machineStatusSectionEl.style.display = 'none';

    try {
        let result;
        if (isVanityUrlLoad && initialSRCodeFromServer === trimmedSrCode && initialPageLoadData && initialPageLoadData.locationDetails) {
            console.log("Vanity URL load: Using pre-loaded location details from server.");
            result = {
                success: true,
                rooms: initialPageLoadData.locationDetails.rooms.map(r => ({ id: r.id, name: r.room_name })),
                locationDetails: initialPageLoadData.locationDetails
            };
            if (result.locationDetails.location && result.locationDetails.location.location_name) {
                updatePageAndHeaderTitle(result.locationDetails.location.location_name);
            }

        } else {
            const response = await fetch(`/api/set-location`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ srcCode: trimmedSrCode })
            });
            result = await response.json();

            if (!response.ok || !result.success) {
                updatePageAndHeaderTitle('');
                throw new Error(result.error || result.message || `Failed to set location for ${trimmedSrCode}.`);
            }
            let locationNameForResult = '';
            if (result.locationDetails && result.locationDetails.location && result.locationDetails.location.location_name) {
                locationNameForResult = result.locationDetails.location.location_name;
            }
            updatePageAndHeaderTitle(locationNameForResult);
        }


        currentSelectedSRCode = trimmedSrCode;
        localStorage.setItem('laundrySRCode', currentSelectedSRCode);
        if (currentSrCodeDisplayEl) currentSrCodeDisplayEl.textContent = currentSelectedSRCode;
        if (srCodeInputEl) srCodeInputEl.value = '';

        const newUrlPath = `/${trimmedSrCode}/`;

        if (window.location.pathname !== newUrlPath) {
            const stateObject = { srCode: trimmedSrCode };
            try {
                history.pushState(stateObject, '', newUrlPath);
                console.log(`URL updated to: ${newUrlPath} (SR code set: ${trimmedSrCode})`);
            } catch (e) {
                console.error("Failed to update URL with history.pushState:", e);
            }
        }

        displayRooms(result.rooms);
        return { success: true, rooms: result.rooms, locationDetails: result.locationDetails };

    } catch (error) {
        if (mainHeaderTitleEl && mainHeaderTitleEl.textContent.includes('Loading')) {
            updatePageAndHeaderTitle('');
        }
        console.error('Error setting location:', error);
        if (srCodeErrorEl) {
            srCodeErrorEl.textContent = error.message;
            srCodeErrorEl.style.display = 'block';
        }
        if (roomListEl) roomListEl.innerHTML = `<li>${error.message} Please check the code or try again.</li>`;
        return { success: false, rooms: [], locationDetails: null, error: error.message };
    } finally {
        if (submitSrCodeBtn) {
            submitSrCodeBtn.disabled = false;
            submitSrCodeBtn.textContent = 'Set Location & View Rooms';
        }
    }
}

async function fetchMachineStatus(roomId, roomName) {
    if (!roomId) return;

    currentRoomNameEl.textContent = `Status for: ${decodeHtmlEntities(roomName)}`;
    machineStatusSectionEl.style.display = 'block';
    washersListEl.innerHTML = '<li class="loading">Loading washer status...</li>';
    dryersListEl.innerHTML = '<li class="loading">Loading dryer status...</li>';

    roomSelectionEl.style.display = 'none';
    if (toggleRoomsBtn) toggleRoomsBtn.textContent = 'Show Room List';

    try {
        const response = await fetch(`/api/room/${roomId}/status`);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Server error. Check console.' }));
            throw new Error(`HTTP ${response.status}: ${errorData.message || errorData.error || 'Failed to fetch status'}`);
        }
        const statusData = await response.json();
        if (lastRoomStatusCache[roomId] && JSON.stringify(lastRoomStatusCache[roomId].data) === JSON.stringify(statusData)) {
            console.log(`Status for room ${roomId} unchanged, skipping re-render.`);
            return;
        }
        lastRoomStatusCache[roomId] = { data: statusData, timestamp: Date.now() };

        renderMachines(statusData.washers, washersListEl, 'Washer');
        renderMachines(statusData.dryers, dryersListEl, 'Dryer');

    } catch (error) {
        console.error(`Error fetching status for room ${roomId}:`, error);
        washersListEl.innerHTML = `<li>${error.message}</li>`;
        dryersListEl.innerHTML = `<li>${error.message}</li>`;
    }
}

function createMoreInfoButton(machineData) {
    const button = document.createElement('button');
    button.textContent = 'Info';
    button.classList.add('more-info-btn');
    button.style.marginLeft = '5px';
    button.style.padding = '2px 6px';
    button.style.fontSize = '0.75em';
    button.addEventListener('click', () => showMachineDetailsModal(machineData));
    return button;
}

function showMachineDetailsModal(machineData) {
    const existingModal = document.getElementById('machine-details-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'machine-details-modal';
    modal.style.position = 'fixed';
    modal.style.left = '50%';
    modal.style.top = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
    modal.style.backgroundColor = 'white';
    modal.style.padding = '20px';
    modal.style.border = '1px solid #ccc';
    modal.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';
    modal.style.zIndex = '1000';
    modal.style.maxHeight = '80vh';
    modal.style.overflowY = 'auto';
    modal.style.minWidth = '300px';


    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.classList.add('close-modal-btn');
    closeButton.onclick = () => modal.remove();

    const content = document.createElement('pre');
    content.textContent = JSON.stringify(machineData, null, 2);

    modal.appendChild(content);
    modal.appendChild(closeButton);
    document.body.appendChild(modal);
}

function renderMachines(machines, listElement, typeName) {
    const staleIndicator = listElement.querySelector('.stale-data-indicator');
    if (staleIndicator) staleIndicator.remove();

    const newMachineMap = new Map();
    if (machines && Array.isArray(machines)) {
        machines.forEach(machine => {
            const uniqueId = machine.BTName || `${typeName}-${machine.LabelID || machine.ID}`;
            newMachineMap.set(uniqueId, machine);
        });
    }

    const existingListItems = Array.from(listElement.children);
    const itemsToRemove = [];

    existingListItems.forEach(li => {
        if (li.classList.contains('loading')) {
            itemsToRemove.push(li);
            return;
        }
        const machineUniqueId = li.dataset.machineUniqueId;

        if (newMachineMap.has(machineUniqueId)) {
            const machine = newMachineMap.get(machineUniqueId);
            const statusInfo = getDisplayStatus(machine.LMCStatus, machine.idleFlag, machine.RemainingMin, typeName);
            const machineLabel = machine.LabelID || 'N/A';

            const newNameText = `${typeName} ${machineLabel}`;
            const newStatusText = statusInfo.text;
            let newTimeText = '';
            if (statusInfo.showTime && machine.RemainingMin && parseInt(machine.RemainingMin) > 0) {
                newTimeText = ` (${machine.RemainingMin} min remaining)`;
            }

            let nameSpan = li.querySelector('.machine-name-text');
            if (!nameSpan) { nameSpan = document.createElement('span'); nameSpan.className = 'machine-name-text'; li.insertBefore(nameSpan, li.firstChild); }
            if (nameSpan.textContent !== newNameText) nameSpan.textContent = newNameText;

            let colonNode = nameSpan.nextSibling;
            if (!colonNode || colonNode.nodeType !== Node.TEXT_NODE || colonNode.textContent.trim() !== ':') {
                if (colonNode && (colonNode.nodeType !== Node.TEXT_NODE || colonNode.textContent.trim() !== ':')) { colonNode.remove(); }
                colonNode = document.createTextNode(': ');
                nameSpan.insertAdjacentElement('afterend', colonNode);
            }

            let statusTextSpan = li.querySelector('.machine-status-text');
            if (!statusTextSpan || statusTextSpan.previousSibling !== colonNode) {
                if(statusTextSpan) statusTextSpan.remove();
                statusTextSpan = document.createElement('span'); statusTextSpan.className = 'machine-status-text';
                colonNode.insertAdjacentElement('afterend', statusTextSpan);
            }
            if (statusTextSpan.textContent !== newStatusText || !statusTextSpan.classList.contains(statusInfo.class.split(' ')[0])) {
                statusTextSpan.textContent = newStatusText;
                statusTextSpan.className = `machine-status-text ${statusInfo.class || ''}`.trim();
            }

            let timeSpan = li.querySelector('.machine-time-text');
            if (newTimeText) {
                if (!timeSpan || timeSpan.previousSibling !== statusTextSpan) {
                    if(timeSpan) timeSpan.remove();
                    timeSpan = document.createElement('span'); timeSpan.className = 'machine-time-text';
                    statusTextSpan.insertAdjacentElement('afterend', timeSpan);
                }
                if (timeSpan.textContent !== newTimeText) timeSpan.textContent = newTimeText;
            } else if (timeSpan) { timeSpan.remove(); timeSpan = null; }

            let notifyBtnContainer = li.querySelector('.notify-btn-container');
            const anchorElementForNotifyButton = timeSpan || statusTextSpan;

            if (statusInfo.showTime && machine.RemainingMin && parseInt(machine.RemainingMin) > 0) {
                if (!notifyBtnContainer || notifyBtnContainer.previousSibling !== anchorElementForNotifyButton) {
                    if (notifyBtnContainer) notifyBtnContainer.remove();
                    notifyBtnContainer = document.createElement('span'); notifyBtnContainer.className = 'notify-btn-container';
                    anchorElementForNotifyButton.insertAdjacentElement('afterend', notifyBtnContainer);
                }
                let existingNotifyBtn = notifyBtnContainer.querySelector('.notify-btn');
                if (!existingNotifyBtn) {
                    const newBtn = createNotifyButton(machine, typeName, machineLabel, machineUniqueId);
                    notifyBtnContainer.innerHTML = ' '; notifyBtnContainer.appendChild(newBtn);
                } else {
                    const isWatching = localStorage.getItem(`watching_${machine.BTName || machineUniqueId}`) === 'true';
                    existingNotifyBtn.textContent = isWatching ? 'Stop Watching' : 'Notify Me';
                    if (isWatching) existingNotifyBtn.classList.add('watching'); else existingNotifyBtn.classList.remove('watching');
                    existingNotifyBtn.dataset.machineBtname = machine.BTName || machineUniqueId;
                    existingNotifyBtn.dataset.machineLabel = machineLabel;
                }
            } else if (notifyBtnContainer) { notifyBtnContainer.remove(); notifyBtnContainer = null;}


            let moreInfoBtn = li.querySelector('.more-info-btn');
            const anchorElementForMoreInfo = notifyBtnContainer || timeSpan || statusTextSpan;

            if (!moreInfoBtn) {
                moreInfoBtn = createMoreInfoButton(machine);
                anchorElementForMoreInfo.insertAdjacentElement('afterend', moreInfoBtn);
            } else {
                const newMoreInfoBtn = createMoreInfoButton(machine);
                moreInfoBtn.replaceWith(newMoreInfoBtn);
            }

            newMachineMap.delete(machineUniqueId);
        } else {
            itemsToRemove.push(li);
        }
    });

    itemsToRemove.forEach(li => listElement.removeChild(li));

    newMachineMap.forEach(machine => {
        const li = document.createElement('li');
        const uniqueId = machine.BTName || `${typeName}-${machine.LabelID || machine.ID}`;
        li.dataset.machineUniqueId = uniqueId;
        const statusInfo = getDisplayStatus(machine.LMCStatus, machine.idleFlag, machine.RemainingMin, typeName);
        const machineLabel = machine.LabelID || 'N/A';

        const nameSpan = document.createElement('span'); nameSpan.className = 'machine-name-text';
        nameSpan.textContent = `${typeName} ${machineLabel}`; li.appendChild(nameSpan);
        li.appendChild(document.createTextNode(': '));
        const statusTextSpan = document.createElement('span'); statusTextSpan.className = `machine-status-text ${statusInfo.class || ''}`.trim();
        statusTextSpan.textContent = statusInfo.text; li.appendChild(statusTextSpan);

        let lastAppendedElement = statusTextSpan;

        if (statusInfo.showTime && machine.RemainingMin && parseInt(machine.RemainingMin) > 0) {
            const timeSpan = document.createElement('span'); timeSpan.className = 'machine-time-text';
            timeSpan.textContent = ` (${machine.RemainingMin} min remaining)`; li.appendChild(timeSpan);
            lastAppendedElement = timeSpan;
        }

        if (statusInfo.showTime && machine.RemainingMin && parseInt(machine.RemainingMin) > 0) {
            const notifyBtnContainer = document.createElement('span'); notifyBtnContainer.className = 'notify-btn-container';
            notifyBtnContainer.appendChild(document.createTextNode(' '));
            notifyBtnContainer.appendChild(createNotifyButton(machine, typeName, machineLabel, uniqueId));
            li.appendChild(notifyBtnContainer);
            lastAppendedElement = notifyBtnContainer;
        }

        const moreInfoBtn = createMoreInfoButton(machine);
        li.appendChild(moreInfoBtn);

        listElement.appendChild(li);
    });

    if (listElement.children.length === 0 && !listElement.querySelector('.loading')) {
        listElement.innerHTML = (machines === null || (Array.isArray(machines) && machines.length > 0 && !listElement.querySelector('li:not(.loading)'))) ?
            `<li>Failed to load ${typeName.toLowerCase()} status.</li>` :
            `<li>No ${typeName.toLowerCase()}s currently listed for this room.</li>`;
    }
}


async function handleNotifyMeClick(event) {
    const button = event.target;
    const machineBTName = button.dataset.machineBtname;
    const machineLabel = button.dataset.machineLabel;
    const roomName = button.dataset.roomName;

    if (!currentPushSubscription) {
        console.log('No push subscription found, attempting to subscribe...');
        const subscription = await requestNotificationPermissionAndSubscribe();
        if (!subscription) {
            alert('Could not set up notifications. Please ensure permission is granted.');
            return;
        }
    }

    const isCurrentlyWatching = localStorage.getItem(`watching_${machineBTName}`) === 'true';

    if (isCurrentlyWatching) {
        try {
            const response = await fetch('/api/unwatch-machine', {
                method: 'POST',
                body: JSON.stringify({ machineBTName: machineBTName }),
                headers: { 'content-type': 'application/json' }
            });
            if (!response.ok) throw new Error('Failed to unwatch machine.');
            localStorage.removeItem(`watching_${machineBTName}`);
            button.textContent = 'Notify Me';
            button.classList.remove('watching');
            console.log(`Stopped watching ${machineBTName}`);
        } catch (error) {
            console.error('Error unwatching machine:', error);
            alert('Could not stop watching this machine. Please try again.');
        }
    } else {
        try {
            const response = await fetch('/api/watch-machine', {
                method: 'POST',
                body: JSON.stringify({
                    machineBTName: machineBTName,
                    subscriptionEndpoint: currentPushSubscription.endpoint,
                    roomName: roomName,
                    machineLabel: machineLabel
                }),
                headers: { 'content-type': 'application/json' }
            });
            if (!response.ok) throw new Error('Failed to watch machine.');
            localStorage.setItem(`watching_${machineBTName}`, 'true');
            button.textContent = 'Stop Watching';
            button.classList.add('watching');
            console.log(`Now watching ${machineBTName}`);

            const typeNameForAlert = machineBTName.toLowerCase().includes('washer') ? 'Washer' :
                machineBTName.toLowerCase().includes('dryer') ? 'Dryer' : 'Machine';
            alert(`You'll be notified when ${typeNameForAlert} ${machineLabel} is finishing!`);
        } catch (error) {
            console.error('Error watching machine:', error);
            alert('Could not watch this machine. Please try again.');
        }
    }
}

function handleRoomSelection(event) {
    const roomLi = event.currentTarget;
    const roomId = roomLi.dataset.roomId;
    const roomNameFromDataset = roomLi.dataset.roomName;

    currentRoomId = roomId;

    if (statusIntervalId) clearInterval(statusIntervalId);
    fetchMachineStatus(roomId, roomNameFromDataset);
    statusIntervalId = setInterval(() => fetchMachineStatus(roomId, roomNameFromDataset), 20000);

    if (currentSelectedSRCode && roomId) {
        const roomIdentifier = roomId;
        const newUrlPath = `/${currentSelectedSRCode}/${roomIdentifier}`;
        if (window.location.pathname !== newUrlPath) {
            const stateObject = {
                srCode: currentSelectedSRCode,
                roomId: roomId,
                roomName: roomNameFromDataset,
                roomIdentifier: roomIdentifier
            };
            try {
                history.pushState(stateObject, '', newUrlPath);
                console.log(`URL updated to: ${newUrlPath} (using room ID)`);
            } catch (e) {
                console.error("Failed to update URL with history.pushState:", e);
            }
        }
    }
}

window.addEventListener('popstate', (event) => {
    console.log('popstate event:', event.state, "current path:", window.location.pathname);
    if (event.state && event.state.srCode && event.state.roomId && event.state.roomName) {
        currentSelectedSRCode = event.state.srCode;
        currentRoomId = event.state.roomId;
        const roomNameForStatus = event.state.roomName;

        if(currentSrCodeDisplayEl) currentSrCodeDisplayEl.textContent = currentSelectedSRCode;

        console.log(`popstate: Restoring room ID ${currentRoomId} for SR ${currentSelectedSRCode}`);
        if (statusIntervalId) clearInterval(statusIntervalId);
        fetchMachineStatus(currentRoomId, roomNameForStatus);
        statusIntervalId = setInterval(() => fetchMachineStatus(currentRoomId, roomNameForStatus), 20000);

        if (roomSelectionEl) roomSelectionEl.style.display = 'none';
        if (machineStatusSectionEl) machineStatusSectionEl.style.display = 'block';
        if (currentRoomNameEl) currentRoomNameEl.textContent = `Status for: ${decodeHtmlEntities(roomNameForStatus)}`;
        if (toggleRoomsBtn) {
            toggleRoomsBtn.textContent = 'Show Room List';
            toggleRoomsBtn.style.display = 'inline-block';
        }

    } else {
        console.log("popstate: No valid app state or navigating to a URL not directly set by room selection.");
        const pathParts = window.location.pathname.split('/').filter(part => part.length > 0);
        if (pathParts.length === 0) {
            showSrCodeSetup();
        } else if (pathParts.length === 1 && /^[A-Z0-9]{7}$/.test(pathParts[0])) {
            currentSelectedSRCode = pathParts[0];
            if(currentSrCodeDisplayEl) currentSrCodeDisplayEl.textContent = currentSelectedSRCode;
            localStorage.setItem('laundrySRCode', currentSelectedSRCode);
            setLocationAndFetchRooms(currentSelectedSRCode, false);
        } else if (pathParts.length >= 2) {
            console.log("popstate: Looks like a direct nav/refresh to vanity URL. DOMContentLoaded should handle.");
            document.dispatchEvent(new CustomEvent('DOMContentLoadedReEvaluate'));
        } else {
            showSrCodeSetup();
        }
    }
});

function showSrCodeSetup() {
    srCodeSetupEl.style.display = 'block';
    roomSelectionEl.style.display = 'none';
    machineStatusSectionEl.style.display = 'none';
    if (toggleRoomsBtn) toggleRoomsBtn.style.display = 'none';
    currentSrCodeDisplayEl.textContent = 'Not Set';
    updatePageAndHeaderTitle('');
    if (statusIntervalId) clearInterval(statusIntervalId);
    localStorage.removeItem('laundrySRCode');
    currentSelectedSRCode = null;
    srCodeInputEl.focus();
}

if (submitSrCodeBtn) {
    submitSrCodeBtn.addEventListener('click', () => {
        setLocationAndFetchRooms(srCodeInputEl.value);
    });
}
if (srCodeInputEl) {
    srCodeInputEl.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitSrCodeBtn.click();
        }
    });
}

if (changeLocationBtn) {
    changeLocationBtn.addEventListener('click', () => {
        srCodeInputEl.value = currentSelectedSRCode || '';
        showSrCodeSetup();
    });
}

if (toggleRoomsBtn) {
    toggleRoomsBtn.addEventListener('click', () => {
        if (roomSelectionEl.style.display === 'none') {
            roomSelectionEl.style.display = 'block';
            machineStatusSectionEl.style.display = 'none';
            if (statusIntervalId) clearInterval(statusIntervalId);
            currentRoomId = null;
            toggleRoomsBtn.textContent = 'Hide Room List';
        } else {
            roomSelectionEl.style.display = 'none';
            if (currentRoomId && machineStatusSectionEl.style.display === 'block') {
                toggleRoomsBtn.textContent = 'Show Room List';
            } else {
                toggleRoomsBtn.textContent = 'Show Room List';
            }
        }
    });
}

document.addEventListener('DOMContentLoadedReEvaluate', async () => {
    console.log("Re-evaluating DOMContentLoaded logic due to popstate fallback.");
    parseInitialRoomData();
    if (initialSRCodeFromServer) {
    } else if (localStorage.getItem('laundrySRCode')) {
        currentSelectedSRCode = localStorage.getItem('laundrySRCode');
        if(currentSrCodeDisplayEl) currentSrCodeDisplayEl.textContent = currentSelectedSRCode;
        await setLocationAndFetchRooms(currentSelectedSRCode, false);
    } else {
        showSrCodeSetup();
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    parseInitialRoomData();

    updatePageAndHeaderTitle('');

    if (!srCodeSetupEl || !roomListEl ) {
        console.error("FATAL: Critical HTML elements missing.");
        return;
    }

    if (initialSRCodeFromServer) {
        console.log(`Initial Load: From Server - SR: ${initialSRCodeFromServer}, TargetRoomID: ${initialTargetRoomId || 'None'}, TargetRoomName: ${initialTargetRoomName || 'None'}`);
        currentSelectedSRCode = initialSRCodeFromServer;
        if (currentSrCodeDisplayEl) currentSrCodeDisplayEl.textContent = currentSelectedSRCode;
        localStorage.setItem('laundrySRCode', currentSelectedSRCode);

        const setResult = await setLocationAndFetchRooms(initialSRCodeFromServer, true);

        console.log("setResult from setLocationAndFetchRooms (vanity):", setResult);

        if (setResult.success && setResult.locationDetails && setResult.locationDetails.rooms) {

            if (initialTargetRoomId) {
                console.log(`Attempting to select target room. ID: ${initialTargetRoomId}, Name: ${initialTargetRoomName}`);
                if (roomListEl.children.length > 0) {
                    const targetRoomLi = Array.from(roomListEl.children).find(
                        li => li.dataset.roomId === initialTargetRoomId.toString()
                    );

                    if (targetRoomLi) {
                        console.log("Found targetRoomLi:", targetRoomLi.textContent, "Proceeding to handleRoomSelection.");
                        if (currentRoomNameEl && initialTargetRoomName) {
                            currentRoomNameEl.textContent = `Status for: ${decodeHtmlEntities(initialTargetRoomName)}`;
                        }
                        if (roomSelectionEl) roomSelectionEl.style.display = 'none';
                        if (machineStatusSectionEl) machineStatusSectionEl.style.display = 'block';
                        if (toggleRoomsBtn) {
                            toggleRoomsBtn.textContent = 'Show Room List';
                            toggleRoomsBtn.style.display = 'inline-block';
                        }
                        handleRoomSelection({ currentTarget: targetRoomLi });
                    } else {
                        console.warn(`Vanity URL: Target room ID '${initialTargetRoomId}' (Name: '${initialTargetRoomName}') NOT FOUND in displayed list for SR '${initialSRCodeFromServer}'. Check dataset.roomId on LIs. Displaying room list.`);
                        Array.from(roomListEl.children).forEach(li => console.log("Existing LI:", li.textContent, "dataset.roomId:", li.dataset.roomId));

                        if (machineStatusSectionEl) machineStatusSectionEl.style.display = 'none';
                        if (roomSelectionEl && toggleRoomsBtn) {
                            roomSelectionEl.style.display = 'block';
                            toggleRoomsBtn.textContent = 'Hide Room List';
                        }
                    }
                } else {
                    console.warn("roomListEl has no children after displayRooms. This is unexpected if setResult.rooms had items.");
                    if (machineStatusSectionEl) machineStatusSectionEl.style.display = 'none';
                }
            } else {
                console.log(`SR Code ${initialSRCodeFromServer} loaded. Room list displayed.`);
                if (machineStatusSectionEl) machineStatusSectionEl.style.display = 'none';
                if (toggleRoomsBtn && roomListEl.children.length > 0) {
                    toggleRoomsBtn.textContent = 'Hide Room List';
                    toggleRoomsBtn.style.display = 'inline-block';
                } else if (toggleRoomsBtn) {
                    toggleRoomsBtn.style.display = 'none';
                }
            }
        } else {
            console.error("setLocationAndFetchRooms failed or returned no rooms for server-provided SR. Error:", setResult.error, "Result:", setResult, ". Fallback to setup.");
            showSrCodeSetup();
        }
    } else {
        const srCodeFromStorage = localStorage.getItem('laundrySRCode');
        if (srCodeFromStorage) {
            console.log(`Initial Load: From localStorage - SR: ${srCodeFromStorage}`);
            currentSelectedSRCode = srCodeFromStorage;
            if(currentSrCodeDisplayEl) currentSrCodeDisplayEl.textContent = currentSelectedSRCode;
            const sottResult = await setLocationAndFetchRooms(currentSelectedSRCode, false);
            if (sottResult.success && toggleRoomsBtn && (!sottResult.rooms || sottResult.rooms.length === 0) ){
                if (toggleRoomsBtn) toggleRoomsBtn.style.display = 'none';
            }
        } else {
            console.log("Initial Load: No SR code from server or localStorage. Show setup.");
            showSrCodeSetup();
        }
    }
    registerServiceWorkerAndSubscribe();
});


if (toggleRoomsBtn) {
    toggleRoomsBtn.addEventListener('click', () => {
        if (!roomSelectionEl || !machineStatusSectionEl) return;
        if (roomSelectionEl.style.display === 'none') {
            roomSelectionEl.style.display = 'block';
            machineStatusSectionEl.style.display = 'none';
            if (statusIntervalId) clearInterval(statusIntervalId);
            toggleRoomsBtn.textContent = 'Hide Room List';
            if (currentSelectedSRCode) {
                const newUrlPath = `/${currentSelectedSRCode}`;
                if (window.location.pathname !== newUrlPath) {
                    history.pushState({ srCode: currentSelectedSRCode }, '', newUrlPath);
                }
            }
        } else {
            if (currentRoomId && machineStatusSectionEl) {
                roomSelectionEl.style.display = 'none';
                machineStatusSectionEl.style.display = 'block';
                toggleRoomsBtn.textContent = 'Show Room List';
            } else {
                console.log("Toggle rooms: No current room selected to show status for, room list remains visible.");
                toggleRoomsBtn.textContent = 'Hide Room List';
            }
        }
    });
}