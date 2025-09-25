function calculateDestinationPoint(lat, lon, bearing, distance) {
	const R = 6371; // Radio de la Tierra en km
	const latRad = satellite.degreesToRadians(lat);
	const lonRad = satellite.degreesToRadians(lon);
	const bearingRad = satellite.degreesToRadians(bearing);

	const lat2Rad = Math.asin(Math.sin(latRad) * Math.cos(distance / R) +
					Math.cos(latRad) * Math.sin(distance / R) * Math.cos(bearingRad));
	
	const lon2Rad = lonRad + Math.atan2(Math.sin(bearingRad) * Math.sin(distance / R) * Math.cos(latRad),
								Math.cos(distance / R) - Math.sin(latRad) * Math.sin(lat2Rad));

	return [satellite.radiansToDegrees(lat2Rad), satellite.radiansToDegrees(lon2Rad)];
}

function calculateBearing(p1, p2) {
	const [lat1, lon1] = p1;
	const [lat2, lon2] = p2;
	const lat1Rad = satellite.degreesToRadians(lat1);
	const lon1Rad = satellite.degreesToRadians(lon1);
	const lat2Rad = satellite.degreesToRadians(lat2);
	const lon2Rad = satellite.degreesToRadians(lon2);

	const y = Math.sin(lon2Rad - lon1Rad) * Math.cos(lat2Rad);
	const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
			Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(lon2Rad - lon1Rad);
	const bearingRad = Math.atan2(y, x);
	return (satellite.radiansToDegrees(bearingRad) + 360) % 360;
}

function getTleId(tle) {
    if (!tle) return null;
    const lines = tle.trim().split('\n');
    // La línea 2 es la parte más única del TLE
    const line2 = lines.find(line => line.trim().startsWith('2 '));
    return line2 ? line2.trim() : JSON.stringify(lines); // Fallback por seguridad
}

function _calculateViewConePolygon(center, heading, angle, radius) {
    const centerPt = L.latLng(center);
    const leftBearing = (heading - angle / 2 + 360) % 360;
    const rightBearing = (heading + angle / 2) % 360;

    const point1 = calculateDestinationPoint(centerPt.lat, centerPt.lng, leftBearing, radius);
    const point2 = calculateDestinationPoint(centerPt.lat, centerPt.lng, rightBearing, radius);

    return [centerPt, L.latLng(point1), L.latLng(point2)];
}

function _createConeSegment(center, heading, angle, innerRadius, outerRadius) {
    const centerPt = L.latLng(center);
    const leftBearing = (heading - angle / 2 + 360) % 360;
    const numArcPoints = 10;

    const outerArcPoints = [];
    for (let i = 0; i <= numArcPoints; i++) {
        const currentBearing = (leftBearing + (angle * i / numArcPoints));
        outerArcPoints.push(calculateDestinationPoint(centerPt.lat, centerPt.lng, currentBearing, outerRadius));
    }

    if (innerRadius === 0) {
        return [centerPt, ...outerArcPoints.map(p => L.latLng(p))];
    } else {
        const innerArcPoints = [];
        for (let i = numArcPoints; i >= 0; i--) {
            const currentBearing = (leftBearing + (angle * i / numArcPoints));
            innerArcPoints.push(calculateDestinationPoint(centerPt.lat, centerPt.lng, currentBearing, innerRadius));
        }
        return [...outerArcPoints.map(p => L.latLng(p)), ...innerArcPoints.map(p => L.latLng(p))];
    }
}

/**
 * Calcula la posición del Sol en coordenadas ECI (Earth-Centered Inertial).
 * Esencial para determinar el ángulo de fase del satélite.
 * @param {Date} date - La fecha/hora para el cálculo.
 * @returns {{x: number, y: number, z: number}} - Vector de posición ECI en km.
 */
function getSunEci(date) { 
    const jday = satellite.jday(date);
    const mjd = jday - 2400000.5;
    const jd2000 = mjd - 51544.5; 
    const MA = (357.5291 + 0.98560028 * jd2000) % 360;
    const MArad = satellite.degreesToRadians(MA); 
    const L = (280.459 + 0.98564736 * jd2000) % 360; 
    const C = 1.915 * Math.sin(MArad) + 0.020 * Math.sin(2 * MArad); 
    const lambda = satellite.degreesToRadians((L + C) % 360);
    const epsilon = satellite.degreesToRadians(23.4393 - 3.563E-7 * jd2000); 
    const R_AU = 1.00014 - 0.01671 * Math.cos(MArad) - 0.00014 * Math.cos(2 * MArad);
    const R_km = R_AU * 149597870.7; 
    return { x: R_km * Math.cos(lambda), y: R_km * Math.sin(lambda) * Math.cos(epsilon), z: R_km * Math.sin(lambda) * Math.sin(epsilon) }; 
}

/**
 * Objeto para manejar la obtención y cacheo del catálogo de satélites (SATCAT).
 * Proporciona la magnitud estándar (M₀) necesaria para el cálculo.
 */
const satcatManager = {
    cacheKey: 'satelitesarg_satcat_cache',
    cacheDuration: 7 * 24 * 60 * 60 * 1000, // 7 días en milisegundos
    satcat: null,
    isInitialized: false,

    async init() {
        if (this.isInitialized) return;
        try {
            const cachedData = JSON.parse(localStorage.getItem(this.cacheKey));
            if (cachedData && (Date.now() - cachedData.timestamp < this.cacheDuration)) {
                this.satcat = new Map(cachedData.data);
                console.log("SATCAT cargado desde caché.");
            } else {
                await this._fetchAndCache();
            }
        } catch (e) {
            console.error("Error al inicializar SATCAT, intentando descargar de nuevo...", e);
            await this._fetchAndCache();
        }
        this.isInitialized = true;
    },

    async _fetchAndCache() {
        try {
            console.log("Descargando SATCAT de CelesTrak...");
            const response = await fetch('https://celestrak.org/pub/satcat.json');
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const data = await response.json();
            
            this.satcat = new Map();
            data.forEach(sat => this.satcat.set(sat.NORAD_CAT_ID, sat));

            const dataToCache = {
                timestamp: Date.now(),
                data: Array.from(this.satcat.entries())
            };
            localStorage.setItem(this.cacheKey, JSON.stringify(dataToCache));
            console.log("SATCAT descargado y guardado en caché.");
        } catch (error) {
            console.error("Fallo en la descarga de SATCAT:", error);
            this.satcat = new Map(); // Evita fallos si la descarga falla
        }
    },

    _parseNoradFromTle(tle) {
        if (!tle) return null;
        const lines = tle.trim().split('\n');
        const line = lines.find(l => l.trim().startsWith('2 '));
        return line ? parseInt(line.substring(2, 7), 10) : null;
    },

    getStandardMagnitude(noradId) {
        if (!this.isInitialized || !this.satcat.has(noradId)) {
            return 5.0; // Magnitud por defecto si no se encuentra el satélite.
        }
        const satData = this.satcat.get(noradId);

        // Prioridad 1: Usar la magnitud estándar proveída por CelesTrak si existe.
        if (typeof satData.MAG === 'number') {
            return satData.MAG;
        }

        // Prioridad 2 (Fallback): Estimar la magnitud a partir del RCS si no hay MAG.
        const rcs = satData.RCS_SIZE;
        let rcsValue = 1.0; // Default a MEDIUM

        if (typeof rcs === 'number') {
            rcsValue = rcs;
        } else if (typeof rcs === 'string') {
            if (rcs === 'SMALL') rcsValue = 0.1;
            else if (rcs === 'LARGE') rcsValue = 10.0;
        }
        
        // Fórmula simplificada para estimar la magnitud estándar desde el RCS.
        // Se asegura que rcsValue no sea cero o negativo para evitar errores de logaritmo.
        return -1.5 - 2.5 * Math.log10(Math.max(0.001, rcsValue));
    }
};

document.addEventListener('DOMContentLoaded', () => {
	const App = {
		state: {
			audioInitialized: false, mapInitialized: false, trackedSatellites: [], observerCoords: null,
			nightOverlayLayer: null,
			observerTimeZone: null, 
			geocodeControllers: { map: null, bestPasses: null },
			geocodeTimeouts: { map: null, bestPasses: null },
			userLocationMarkers: [], map: null, sounds: {}, realTimeInterval: null,
			currentTime: new Date(), isTimeTraveling: false, isPassViewActive: false, passTrajectoryDrawn: false, timeStepIndex: 1,
			baseLayers: {}, currentBaseLayer: null, visibilityBands: { layers: [], visible: false, trajectory: [] },
			allBestPasses: [],
			previousBestPassesLoaded: false,
			pendingPassJumpTimestamp: null,
			currentSkyPath: [],
			lastRadarUpdateTime: 0,
			isSpecialOrbitModeActive: false, 
			nextVisiblePass: null,
			
			selectedSatForOrbit: null,
			isMultiSelectMode: false,
			selectedTlesForMulti: [],
			staggeredUpdateInterval: null,
			nextSatToUpdateIndex: 0,
            dailyUpdateCarouselInterval: null,
            currentPassFilter: 'all', // Opciones: 'all', 'dusk', 'dawn'
            currentBestPassesSource: 'favorites', // Opciones: 'favorites', 'all'
            unfilteredModalPasses: [],
			// *** NUEVO: Estado para el modo "Cerca" ***
			isNearbyModeActive: false,
			nearby: {
				satellites: [], // Lista de satélites cercanos con sus marcadores
				circle: null,   // Círculo azul de 1200km
				mask: null,     // Máscara oscura para el exterior del círculo
				updateInterval: null, // Intervalo para actualizar posiciones en este modo
				allSats: [], // Cache de todos los satélites disponibles
				selectedSatForOrbit: null // Satélite seleccionado para mostrar órbita en el radar
			},
            // *** NUEVO: Estado para el cálculo incremental de pases ***
            passCalculation: {
                inProgress: false,
                controller: null,
                daysCalculated: 0,
                firstPassFound: false,
                startDate: null,
                satsToCalculate: [],
                renderTarget: null, // 'bestPasses' o 'modal'
                allFoundPasses: []
            },
            viewConeLayer: null,
			isManualLocationMode: false
		},
		config: {
			timeSteps: [ { unit: 'seconds', label: 'SEG', value: 1000 }, { unit: 'minutes', label: 'MIN', value: 60000 }, { unit: 'hours', label: 'HS', value: 3600000 }, ],
			localStorageKey: 'satelitesarg_my_satellites',
			customTleStorageKey: 'satelitesarg_custom_tles',
			locationStorageKey: 'satelitesarg_user_location',
			lastSatStorageKey: 'satelitesarg_last_satellite',
			knownTlesCacheKey: 'satelitesarg_known_tles_cache',
			brightestTlesCacheKey: 'satelitesarg_brightest_tles_cache',
			settingsStorageKey: 'satelitesarg_settings',
			predictionGracePeriodMinutes: 40,
			predictionFutureDays: 30,
			predictionPastDays: 3,
			maxPassesToCalculate: 20, // Esto ahora aplica por lote
            // *** NUEVO: Configuración para el cálculo incremental ***
            passCalculationBatchSize: 5, // Días a calcular por lote
            passCalculationMaxDays: 30,
            bestPassesCacheTTL: 15 * 60 * 1000, // 15 minutos en milisegundos
		},
		getUtcOffsetForDate(tz, dateUtc) {
			try {
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: tz,
					timeZoneName: 'longOffset'
				});
				const formatted = formatter.formatToParts(dateUtc);
				const offsetPart = formatted.find(part => part.type === 'timeZoneName');
				if (!offsetPart) return '+00:00';
				let offset = offsetPart.value.replace('GMT', '');
				if (offset === 'Z' || offset === '') offset = '+00:00';
				if (offset.includes(':') && offset.length < 6) {
					const [hours, minutes] = offset.split(':');
					const sign = hours.startsWith('-') || hours.startsWith('+') ? hours.charAt(0) : '+';
					const absHours = hours.replace(/[-+]/, '');
					return `${sign}${absHours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
				}
				return offset;
			} catch (e) {
				console.error(`Invalid timezone identifier: '${tz}'. Falling back to UTC offset.`);
				return '+00:00';
			}
		},
		elements: {},
		async init() {
            satcatManager.init();
			// Asignamos la configuración de satélites desde el archivo externo
			this.config.knownSatellites = SATELLITES_CONFIG.knownSatellites;
			
			this.config.latestStarlinks = SATELLITES_CONFIG.latestStarlinks.map(sat => {
                // Se revierte a la lógica original para leer el nombre directamente desde la primera línea del TLE.
                // Esto permite que el archivo de configuración sea más fácil de actualizar.
                if (sat.tle) {
                    const parsed = this.satellites.parseTLE(sat.tle.trim());
                    if (parsed.length > 0 && parsed[0].name) {
                        // Reconstruye el TLE de 3 líneas para consistencia, usando el nombre parseado.
                        const fullTle = `${parsed[0].name}\n${parsed[0].line1}\n${parsed[0].line2}`;
                        return { name: parsed[0].name, tle: fullTle };
                    }
                }
                return sat; // Devuelve el original si falla el parseo
            });

			this.config.brightestSatellites = SATELLITES_CONFIG.brightestSatellites;
			
			this.settings.init();
			await this.language.set(this.settings.current.language);

			this.cacheDOMElements(); this.location.loadFromStorage();
            this.ui.showDailyUpdate();
			this.setupEventListeners(); this.mySatellites.renderKnownSatellitesList();
			this.satellites.updateTlesFromSource(); 
			this.satellites.updateBrightestTlesFromSource();
			this.ui.updateButtonsState();
			this.navigation.init();
			this.mapLayers.init();
			this.radar.init();
			this.notifications.init();
			this.elements.languageDropdownMenu.classList.remove('hidden'); 
			this.time.updateResetTimeButtonState(); // Initialize button state
		},
		cacheDOMElements() {
			const ids = [ 'start-screen', 'known-satellites-screen', 'app-container', 'open-known-satellites-btn', 'open-map-btn', 'back-to-start-btn', 'back-btn-from-map', 'tle-modal', 'close-tle-modal-btn', 'save-tle-btn', 'tle-input', 'tle-status', 'location-input', 'location-feedback', 'predict-passes-btn', 'passes-modal', 'passes-modal-title', 'close-passes-modal-btn', 'results-container', 'main-control-panel', 'collapsed-header', 'expanded-content', 'toggle-menu-btn', 'utc-time-display', 'time-control-panel', 'toggle-time-control-btn', 'reset-time-btn', 'time-rewind-btn', 'time-step-btn', 'time-forward-btn', 'timeline-slider', 'date-input', 'time-input', 'date-input-display', 'time-input-display', 'current-time-display', 'my-satellites-screen', 'open-my-satellites-btn', 'my-satellites-list', 'no-my-satellites-msg', 'add-my-satellite-btn', 'back-to-known-btn', 'known-satellites-list', 'confirm-modal', 'confirm-modal-text', 'confirm-delete-btn', 'cancel-delete-btn', 'open-favorites-modal-btn', 'favorites-modal', 'close-favorites-modal-btn', 'favorites-modal-list', 'map-style-switcher', 'map-style-toggle-btn', 'map-style-options', 'action-controls', 'visibility-controls', 'toggle-visibility-bands-btn', 'visibility-legend', 'satellite-info-header', 'satellite-name-display', 'satellite-info-modal', 'satellite-info-modal-title', 'satellite-info-content', 'close-satellite-info-modal-btn', 'open-best-passes-btn', 'best-passes-screen', 'best-passes-list', 'back-to-start-from-best-passes-btn', 'best-passes-location-input', 'best-passes-location-feedback', 'best-passes-filter', 'open-latest-starlinks-btn', 'add-tle-from-main-btn', 'back-to-start-from-known-btn', 'back-to-start-from-passes-btn', 'location-search-btn', 'location-search-icon', 'best-passes-location-search-btn', 'best-passes-location-search-icon', 'back-to-known-from-my-satellites-btn', 'open-compass-menu-btn', 'panel-pages-wrapper', 'show-previous-best-passes-btn', 'show-previous-container', 'best-passes-scroller', 'prediction-date-display', 'radar-canvas', 'radar-pointer', 'expand-radar-btn', 'radar-modal', 'close-radar-modal-btn', 'large-radar-canvas', 'large-radar-pointer', 'calibrate-compass-btn', 'time-control-handle', 'info-screen-about', 'info-screen-guide', 'info-screen-legal', 'back-to-start-from-about-btn', 'back-to-start-from-guide-btn', 'back-to-start-from-legal-btn', 'open-social-btn', 'social-modal', 'close-social-modal-btn', 'close-time-control-btn', 'page-indicator-dots', 'toggle-multi-select-btn', 'multi-select-counter', 'show-selected-sats-btn', 'favorites-modal-footer', 'passes-modal-filter', 'show-all-satellites-btn', 'info-screen-settings', 'back-to-start-from-settings-btn', 'open-settings-btn', 'setting-map-dark', 'setting-map-satellite', 'language-dropdown-toggle', 'current-language-display', 'language-dropdown-menu', 'notification-modal', 'close-notification-modal-btn', 'notification-options', 'done-notification-modal-btn', 'open-brightest-satellites-btn', 'brightest-satellites-screen', 'brightest-satellites-list', 'back-to-known-from-brightest-btn', 'best-passes-filter-container', 'passes-modal-filter-container', 'best-passes-source-filter-container', 'known-satellites-search-input', 'brightest-satellites-search-input', 'search-container-known', 'search-toggle-btn-known', 'favorite-satellites-list-known-screen', 'favorite-satellites-search-input', 'search-container-favorites', 'search-toggle-btn-favorites', 'no-favorites-on-known-screen-msg', /* *** NUEVO: IDs para los botones "Ver más" *** */ 'view-more-container-best-passes', 'view-more-btn-best-passes', 'view-more-container-modal', 'view-more-btn-modal', 'loading-modal', 'loading-modal-text', 'latest-starlinks-screen', 'back-to-known-from-starlinks-btn', 'latest-starlinks-content', 'daily-update-pill', 'daily-update-icon', 'daily-update-text-pill', 'daily-update-title', 'daily-update-modal', 'daily-update-modal-content', 'close-daily-update-modal-btn', 'radar-moon-icon', 'large-radar-moon-icon', 'daily-update-main-pill', 'nearby-button', 'info-screen-moon', 'back-to-start-from-moon-btn', 'moon-phase-container', 'bottom-nav-bar', 'menu-screen', 'back-to-start-from-menu-btn', 'menu-btn-about', 'menu-btn-guide', 'menu-btn-contact', 'menu-btn-settings', 'events-screen', 'back-to-start-from-events-btn', 'nav-btn-home', 'nav-btn-events', 'nav-btn-moon', 'nav-btn-menu', 'toggle-night-overlay-btn', 'setting-day-night-on', 'setting-day-night-off' ];
			ids.forEach(id => { const camelCaseId = id.replace(/-(\w)/g, (_, c) => c.toUpperCase()); this.elements[camelCaseId] = document.getElementById(id); });
			if (this.elements.pageIndicatorDots) {
				this.elements.pageIndicatorDots.dots = this.elements.pageIndicatorDots.querySelectorAll('.dot');
			}
		},
		initMap() {
			if (this.state.mapInitialized) return;

			// Sincroniza el estado visual del interruptor con el ajuste guardado
			if(App.elements.toggleNightOverlayBtn) {
				App.elements.toggleNightOverlayBtn.checked = this.settings.current.showNightOverlay;
			}

			this.state.map = L.map('map', { 
				zoomControl: false, 
				attributionControl: false, 
				maxBounds: [[-90, -540], [90, 540]], 
				minZoom: 2, 
				zoomSnap: 0.1, 
				zoomDelta: 0.25, 
				zoomAnimation: true, 
				zoomAnimationThreshold: 4,
				worldCopyJump: false
			}).setView([20, 0], 2);
			
			this.state.map.createPane('visibilityBandsPane');
			this.state.map.getPane('visibilityBandsPane').style.zIndex = 440;
			this.state.map.getPane('visibilityBandsPane').style.pointerEvents = 'none';

			this.state.map.createPane('trajectoryPane');
			this.state.map.getPane('trajectoryPane').style.zIndex = 450;
			this.state.map.getPane('trajectoryPane').style.pointerEvents = 'none';

			this.nightOverlay.init();

			this.mapLayers.defineLayers(); 
			this.mapLayers.switchLayer(this.settings.current.defaultMapLayer);

			this.state.map.on('moveend', () => {
				if (this.state.isPassViewActive) {
					this.prediction.updateTrajectoryLabelsVisibility();
				}
			});

			// --- INICIO: Limpiar trayectoria con clic en el mapa ---
			this.state.map.on('click', (e) => {
				// Si está en modo de selección manual, no hace nada más aquí.
				// La lógica se maneja en el listener específico que se añade y quita dinámicamente.
				if (App.state.isManualLocationMode) {
					return;
				}

				const isMarkerClick = e.originalEvent.target.closest('.leaflet-marker-icon');
				const isControlClick = e.originalEvent.target.closest('.leaflet-control');
		
				// En modo "Cerca", si se hace clic fuera de un marcador y hay una órbita seleccionada, se limpia.
				if (this.state.isNearbyModeActive && !isMarkerClick && !isControlClick && this.state.nearby.selectedSatForOrbit) {
					this.state.nearby.selectedSatForOrbit = null;
					this.playSound('uiClick', 'A3');
				}
			});
			// --- FIN: Limpiar trayectoria con clic en el mapa ---
			
			this.state.mapInitialized = true;
		},
		setupEventListeners() {
			const { elements } = this;

			elements.openMapBtn.addEventListener('click', () => this.openMapAndTrackDefault());

			// *** Manejador de clics para las etiquetas de satélite en el mapa (usando delegación de eventos) ***
			elements.appContainer.addEventListener('click', (e) => {
				const label = e.target.closest('.satellite-label');
				
				if (label) {
					e.stopPropagation(); // Evita que el clic llegue al mapa
					const childWithId = label.querySelector('[data-tle-id]');
					if (childWithId && childWithId.dataset.tleId) {
						const tleId = childWithId.dataset.tleId;
						
						// Determina en qué lista de satélites buscar según el modo actual
						const satelliteList = App.state.isNearbyModeActive ? App.state.nearby.satellites : App.state.trackedSatellites;
						const sat = satelliteList.find(s => getTleId(s.tle) === tleId);
						
						if (sat) {
							// La acción principal para la etiqueta es mostrar información.
							this.satellites.showInfoModal(sat);
						}
					}
					return;
				}
			});
			
			elements.openKnownSatellitesBtn.addEventListener('click', () => { this.playSound('uiClick', 'D4'); this.navigation.go('known-satellites-screen'); });
			
			elements.backToStartFromKnownBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.backToStartFromPassesBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			
			elements.backBtnFromMap.addEventListener('click', () => {
				this.playSound('uiClick', 'A3');
				const panel = this.elements.mainControlPanel;

				// Si el modo "Cerca" está activo, lo desactivamos primero
				if (this.state.isNearbyModeActive) {
					this.nearbyMode.stop();
				} else if (panel.classList.contains('show-compass')) {
					panel.classList.remove('show-compass');
					this.radar.stop();
				} else {
					this.radar.stop();
					history.back();
				}
			});

			// Asignamos el evento al botón "Cerca"
			if (elements.nearbyButton) {
				elements.nearbyButton.addEventListener('click', () => this.nearbyMode.toggle());
			}

			const setupInfoScreenButton = (buttonId, screenId, note) => {
				const button = document.getElementById(buttonId); 
				if(button) {
					button.addEventListener('click', () => { 
						this.playSound('uiClick', note); 
						this.navigation.go(screenId); 
						this.ui.setMenuState(false);
					});
				}
			};
			setupInfoScreenButton('open-about-btn', 'info-screen-about', 'C4');
			setupInfoScreenButton('open-guide-btn', 'info-screen-guide', 'C4');
			setupInfoScreenButton('open-legal-btn', 'info-screen-legal', 'C4');
			setupInfoScreenButton('open-settings-btn', 'info-screen-settings', 'C4');

			elements.backToStartFromAboutBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.backToStartFromGuideBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.backToStartFromLegalBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.backToStartFromSettingsBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.backToStartFromMoonBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });

			elements.backToStartFromMenuBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.menuBtnAbout.addEventListener('click', () => { this.playSound('uiClick', 'C4'); this.navigation.go('info-screen-about'); });
			elements.menuBtnGuide.addEventListener('click', () => { this.playSound('uiClick', 'C4'); this.navigation.go('info-screen-guide'); });
			elements.menuBtnContact.addEventListener('click', () => { this.playSound('uiClick', 'C4'); this.navigation.go('info-screen-legal'); });
			elements.menuBtnSettings.addEventListener('click', () => { this.playSound('uiClick', 'C4'); this.navigation.go('info-screen-settings'); });

			elements.backToKnownFromMySatellitesBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.backToKnownFromBrightestBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			
			elements.openBestPassesBtn.addEventListener('click', () => {
				this.playSound('uiClick', 'E4');
				this.navigation.go('best-passes-screen');
			});
			
			elements.openMySatellitesBtn.addEventListener('click', () => { this.playSound('uiClick', 'E4'); this.navigation.go('my-satellites-screen'); });

			elements.openLatestStarlinksBtn.addEventListener('click', () => {
				this.playSound('uiClick', 'F4');
				this.navigation.go('latest-starlinks-screen');
			});

			elements.openBrightestSatellitesBtn.addEventListener('click', () => {
				this.playSound('uiClick', 'G4');
				this.navigation.go('brightest-satellites-screen');
			});

			const openTleModalAction = () => { this.playSound('uiClick', 'C4'); this.elements.tleInput.value = ''; this.ui.showModal(elements.tleModal); };
			elements.addMySatelliteBtn.addEventListener('click', openTleModalAction);
			
			elements.saveTleBtn.addEventListener('click', () => this.mySatellites.handleSaveTle());

			elements.closeTleModalBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.backToKnownFromStarlinksBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.cancelDeleteBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.closePassesModalBtn.addEventListener('click', () => { App.prediction.stopPassCalculation(); this.playSound('uiClick', 'A3'); history.back(); });
			elements.closeFavoritesModalBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.closeSatelliteInfoModalBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			elements.closeRadarModalBtn.addEventListener('click', () => {
				this.playSound('uiClick', 'A3');
				this.radar.stop();
				history.back();
			});
			elements.closeSocialModalBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });
			
			elements.openSocialBtn.addEventListener('click', () => {
				this.playSound('uiClick', 'F4');
				this.ui.showModal(elements.socialModal);
			});

			elements.confirmDeleteBtn.addEventListener('click', (e) => this.mySatellites.confirmDelete(e));
			
			const setupLocationInput = (inputElement, searchBtn, searchIcon, recalculatePasses, type) => {
				// Función para actualizar el ícono (lupa/cruz) según el contenido del input
				const updateIconState = () => {
					const isSuccess = searchIcon.classList.contains('fa-xmark');
					// Si el usuario borra manualmente el texto de una búsqueda ya hecha,
					// el ícono debe volver a ser una lupa.
					if (inputElement.value.trim() === '' && isSuccess) {
						searchIcon.classList.remove('fa-xmark');
						searchIcon.classList.add('fa-magnifying-glass');
						searchBtn.setAttribute('title', App.language.getTranslation('searchLocation'));
					}
				};
			
				// Ahora, el evento 'input' solo actualiza el estado del ícono.
				inputElement.addEventListener('input', () => {
					updateIconState();
				});
			
				searchBtn.addEventListener('click', () => {
					this.playSound('uiClick', 'C4');
					if (searchIcon.classList.contains('fa-xmark')) {
						// Si el ícono es una X, la acción es LIMPIAR
						inputElement.value = '';
						this.location.handleCitySearch('', recalculatePasses, type);
						inputElement.dispatchEvent(new Event('input')); // Se dispara el evento para actualizar el ícono
						inputElement.focus();
					} else {
						// Si es una lupa, la acción es BUSCAR
						this.location.handleCitySearch(inputElement.value, recalculatePasses, type);
					}
				});
			
				inputElement.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						// Se elimina el clearTimeout de acá porque ahora lo maneja la función principal.
						this.location.handleCitySearch(inputElement.value, recalculatePasses, type);
						inputElement.blur();
					}
				});
			};
			setupLocationInput(elements.locationInput, elements.locationSearchBtn, elements.locationSearchIcon, false, 'map');
			setupLocationInput(elements.bestPassesLocationInput, elements.bestPassesLocationSearchBtn, elements.bestPassesLocationSearchIcon, true, 'bestPasses');

			elements.openFavoritesModalBtn.addEventListener('click', () => { this.playSound('uiClick', 'D4'); this.navigation.go('known-satellites-screen'); });
			
			elements.toggleMultiSelectBtn.addEventListener('click', () => this.mySatellites.toggleMultiSelectMode());
			elements.showSelectedSatsBtn.addEventListener('click', () => this.mySatellites.trackMultipleSelected());
			

			elements.predictPassesBtn.addEventListener('click', () => this.prediction.handlePrediction());
            
            // *** NUEVO: Event Listeners para los botones "Ver más" ***
            if(elements.viewMoreBtnBestPasses) {
                elements.viewMoreBtnBestPasses.addEventListener('click', () => this.prediction.calculateNextPassBatch());
            }
            if(elements.viewMoreBtnModal) {
                elements.viewMoreBtnModal.addEventListener('click', () => this.prediction.calculateNextPassBatch());
            }

			elements.satelliteNameDisplay.addEventListener('click', () => { if (this.state.trackedSatellites.length > 0 && this.state.map) { const sat = this.state.trackedSatellites[0]; if (sat.markers.length > 0) { this.playSound('uiClick', 'F4'); this.state.map.flyTo(sat.markers[0].getLatLng(), this.state.map.getZoom(), { duration: 0.8 }); } } });
			
			elements.openCompassMenuBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.playSound('uiClick', 'E4');
				const panel = this.elements.mainControlPanel;
				const isCompassPage = panel.classList.contains('show-compass');
				const isExpanded = panel.classList.contains('expanded');

				if (isExpanded && isCompassPage) {
					panel.classList.remove('expanded');
					this.radar.stop();
					if (App.elements.radarModal && App.elements.radarModal.classList.contains('is-visible')) {
						App.ui.hideModal(App.elements.radarModal, true);
					}
				} else {
					if (!isExpanded) {
						panel.classList.add('expanded');
					}
					if (!isCompassPage) {
						panel.classList.add('show-compass');
						App.ui.updatePageIndicator(true); 
					}
					this.radar.start('radar-canvas', 'radar-pointer');
				}
			});

			elements.expandRadarBtn.addEventListener('click', () => {
				this.playSound('uiClick', 'F4');
				this.ui.showModal(elements.radarModal);
				setTimeout(() => {
					this.radar.start('large-radar-canvas', 'large-radar-pointer');
				}, 500);
			});

			elements.calibrateCompassBtn.addEventListener('click', () => {
				App.playSound('uiClick', 'D4');
                App.radar.showCalibrationMessage(); 
				App.radar.start('radar-canvas', 'radar-pointer');
			});
			
			let isDragging = false, startY = 0, startX = 0, initialMaxHeight = 0, expandedHeight = 0, currentX = 0;
			let dragDirection = 'none';
			const panel = elements.mainControlPanel;
			const innerPanel = panel.querySelector('#panel-inner-wrapper');
			const expandedContent = elements.expandedContent;
			const pagesWrapper = elements.panelPagesWrapper;
			const collapsedHeight = 58;

			const startDrag = (e) => {
				const isHeaderTouch = e.target.closest('#collapsed-header') || e.target.closest('.handle');
				if (!panel.classList.contains('expanded') && !isHeaderTouch) return;
				expandedHeight = expandedContent.scrollHeight + collapsedHeight;
				isDragging = true;
				dragDirection = 'none';
				startY = e.pageY || e.touches[0].pageY;
				startX = e.pageX || e.touches[0].pageX;
				initialMaxHeight = innerPanel.offsetHeight;
				innerPanel.style.transition = 'none';
				pagesWrapper.style.transition = 'none';
				document.body.style.cursor = 'grabbing';
			};

			const onDrag = (e) => {
				if (!isDragging) return;
				e.preventDefault();
				const currentY = e.pageY || e.touches[0].pageY;
				const currentMouseX = e.pageX || e.touches[0].pageX;
				const deltaY = currentY - startY;
				const deltaX = currentMouseX - startX;

				if (dragDirection === 'none') {
					if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) {
						dragDirection = 'vertical';
						elements.pageIndicatorDots.style.opacity = '0';
					} else if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY) && panel.classList.contains('expanded')) {
						dragDirection = 'horizontal';
					}
				}

				if (dragDirection === 'vertical') {
					document.body.style.cursor = 'ns-resize';
					let newMaxHeight = Math.max(collapsedHeight, Math.min(initialMaxHeight + deltaY, expandedHeight + 20));
					innerPanel.style.maxHeight = `${newMaxHeight}px`;
					const expansionProgress = (newMaxHeight - collapsedHeight) / (expandedHeight * 0.75 - collapsedHeight);
					expandedContent.style.opacity = Math.max(0, Math.min(1, expansionProgress));
				} else if (dragDirection === 'horizontal') {
					document.body.style.cursor = 'ew-resize';
					const isCompassVisible = panel.classList.contains('show-compass');
					const baseTranslate = isCompassVisible ? -pagesWrapper.offsetWidth : 0;
					currentX = baseTranslate + deltaX;
					pagesWrapper.style.transform = `translateX(${currentX}px)`;
				}
			};

			const endDrag = (e) => {
				if (!isDragging) return;
				isDragging = false;
				document.body.style.cursor = 'default';
				innerPanel.style.transition = '';
				pagesWrapper.style.transition = '';
				expandedContent.style.opacity = '';
				innerPanel.style.maxHeight = '';
				pagesWrapper.style.transform = '';
				elements.pageIndicatorDots.style.opacity = '';
				if (dragDirection === 'vertical') {
					const shouldBeExpanded = innerPanel.offsetHeight > collapsedHeight * 1.5;
					panel.classList.toggle('expanded', shouldBeExpanded);
					if (!shouldBeExpanded) this.radar.stop();
				} else if (dragDirection === 'horizontal') {
					const finalDeltaX = (e.pageX || e.changedTouches[0].pageX) - startX;
					const panelWidth = pagesWrapper.offsetWidth;
					const isCompassVisible = panel.classList.contains('show-compass');
					if (isCompassVisible && finalDeltaX > panelWidth / 4) {
						panel.classList.remove('show-compass');
						this.playSound('uiClick', 'C4');
						this.radar.stop();
						App.ui.updatePageIndicator(false); 
					} else if (!isCompassVisible && finalDeltaX < -panelWidth / 4) {
						panel.classList.add('show-compass');
						this.playSound('uiClick', 'D4');
						this.radar.start('radar-canvas', 'radar-pointer');
						App.ui.updatePageIndicator(true); 
					}
				}
				dragDirection = 'none';
			};
			
			panel.addEventListener('mousedown', startDrag);
			document.addEventListener('mousemove', onDrag);
			document.addEventListener('mouseup', endDrag);
			panel.addEventListener('touchstart', startDrag, { passive: false });
			document.addEventListener('touchmove', onDrag, { passive: false });
			document.addEventListener('touchend', endDrag);
			
			elements.toggleMenuBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				const isCurrentlyExpanded = panel.classList.contains('expanded');
				if (isCurrentlyExpanded) {
					this.radar.stop();
				}
				panel.classList.toggle('expanded');
				panel.classList.remove('show-compass');
			});
			
			elements.toggleTimeControlBtn.addEventListener('click', () => {
					this.playSound('uiClick', 'C4');
					const isVisible = elements.timeControlPanel.classList.toggle('visible');
					document.body.classList.toggle('time-controls-active', isVisible);
					elements.timeControlHandle.classList.toggle('hidden', !isVisible);
					
					if (this.state.map) {
						if (isVisible) {
							this.state.map.panBy([0, 100], { animate: true, duration: 0.5 });
						} else {
							this.state.map.panBy([0, -100], { animate: true, duration: 0.5 });
						}
					}
				});

			let touchStartY = 0;
			const swipeThreshold = -50; 

			elements.toggleTimeControlBtn.addEventListener('touchstart', (e) => {
				touchStartY = e.touches[0].clientY;
			});

			elements.toggleTimeControlBtn.addEventListener('touchmove', (e) => {
				e.preventDefault();
			});

			elements.toggleTimeControlBtn.addEventListener('touchend', (e) => {
				const touchEndY = e.changedTouches[0].clientY;
				const deltaY = touchEndY - touchStartY;

				if (deltaY < swipeThreshold) {
					if (!elements.timeControlPanel.classList.contains('visible')) {
						this.playSound('uiClick', 'C4');
						elements.timeControlPanel.classList.add('visible');
						document.body.classList.add('time-controls-active');
						elements.timeControlHandle.classList.remove('hidden');

						if (this.state.map) {
							this.state.map.panBy([0, 100], { animate: true, duration: 0.5 });
						}
					}
				}
			});

			elements.closeTimeControlBtn.addEventListener('click', () => {
				this.playSound('uiClick', 'A3'); 
				const timePanel = this.elements.timeControlPanel;
				if (!timePanel.classList.contains('visible')) return;

				timePanel.classList.remove('visible');
				document.body.classList.remove('time-controls-active');
				this.elements.timeControlHandle.classList.add('hidden');
				if (this.state.map) {
					this.state.map.panBy([0, -100], { animate: true, duration: 0.5 });
				}
			});
			
			const timePanel = elements.timeControlPanel;
			const handle = elements.timeControlHandle;
			let isDraggingTimePanel = false, timePanelStartY = 0, lastMapPanY = 0;

			const startTimePanelDrag = (e) => {
				if (e.target.closest('#timeline-slider') || e.target.closest('label[for="date-input"]') || e.target.closest('label[for="time-input"]')) {
                    return;
                }
				if (!timePanel.classList.contains('visible')) return;
				isDraggingTimePanel = true;
				timePanelStartY = e.pageY || e.touches[0].pageY;
				lastMapPanY = 0;
				timePanel.style.transition = 'none';
				handle.style.transition = 'none';
				document.body.style.cursor = 'grabbing';
			};

			const onTimePanelDrag = (e) => {
				if (!isDraggingTimePanel) return;
				e.preventDefault();
				const currentY = e.pageY || e.touches[0].pageY;
				const deltaY = Math.max(0, currentY - timePanelStartY);
				const panelHeight = timePanel.offsetHeight;
				const progress = Math.min(1, deltaY / panelHeight);
				
				if (window.innerWidth >= 1024) {
					timePanel.style.transform = `translateX(-50%) translateY(${deltaY}px)`;
				} else {
					timePanel.style.transform = `translateY(${deltaY}px)`;
				}

				const newOpacity = 1 - progress;
				timePanel.style.opacity = newOpacity;
				handle.style.opacity = newOpacity;

				if (this.state.map) {
					const targetMapPan = progress * -100;
					const panAmount = targetMapPan - lastMapPanY;
					this.state.map.panBy([0, panAmount], { animate: false });
					lastMapPanY = targetMapPan;
				}
			};

			const endTimePanelDrag = (e) => {
				if (!isDraggingTimePanel) return;
				isDraggingTimePanel = false;
				document.body.style.cursor = 'default';
				timePanel.style.transition = '';
				handle.style.transition = '';
				handle.style.opacity = '';

				const currentY = e.changedTouches ? e.changedTouches[0].pageY : e.pageY;
				const deltaY = Math.max(0, currentY - timePanelStartY);
				const panelHeight = timePanel.offsetHeight;
				const progress = Math.min(1, deltaY / panelHeight);

				if (progress > 0.4) {
					timePanel.classList.remove('visible');
					document.body.classList.remove('time-controls-active');
					handle.classList.add('hidden');
					timePanel.style.transform = '';
					timePanel.style.opacity = '';
					if (this.state.map) {
						const remainingPan = -100 - lastMapPanY;
						this.state.map.panBy([0, remainingPan], { animate: true, duration: 0.2 });
					}
				} else {
					timePanel.style.transform = '';
					timePanel.style.opacity = '';
					if (this.state.map) {
						const remainingPan = 0 - lastMapPanY;
						this.state.map.panBy([0, remainingPan], { animate: true, duration: 0.2 });
					}
				}
			};

			timePanel.addEventListener('mousedown', startTimePanelDrag);
			document.addEventListener('mousemove', onTimePanelDrag);
			document.addEventListener('mouseup', endTimePanelDrag);
			timePanel.addEventListener('touchstart', startTimePanelDrag, { passive: false });
			document.addEventListener('touchmove', onTimePanelDrag, { passive: false });
			document.addEventListener('touchend', endTimePanelDrag);
			
			elements.resetTimeBtn.addEventListener('click', () => { this.playSound('uiClick', 'G4'); this.time.stopTimeTravel(); });
			elements.timeStepBtn.addEventListener('click', () => { this.playSound('uiClick', 'E4'); this.state.timeStepIndex = (this.state.timeStepIndex + 1) % this.config.timeSteps.length; elements.timeStepBtn.textContent = this.config.timeSteps[this.state.timeStepIndex].label; });
			elements.timeRewindBtn.addEventListener('click', () => this.time.adjustTime(-1)); elements.timeForwardBtn.addEventListener('click', () => this.time.adjustTime(1));
			elements.dateInput.addEventListener('change', () => this.time.setTimeFromInputs()); elements.timeInput.addEventListener('change', () => this.time.setTimeFromInputs());
			
			elements.timelineSlider.addEventListener('input', () => this.time.setTimeFromSlider());

			elements.toggleVisibilityBandsBtn.addEventListener('click', () => this.prediction.toggleVisibilityBands());
			
			elements.showPreviousBestPassesBtn.addEventListener('click', () => this.prediction.showPreviousBestPasses());

            // --- INICIO: Lógica para mostrar/ocultar botón de pasos previos ---
            const { bestPassesScroller, showPreviousContainer } = elements;
            if (bestPassesScroller && showPreviousContainer) {
                let touchStartY = 0;
                let isDragging = false;
                let atTopSince = 0; // 0 means not at top, otherwise it's a timestamp
                const requiredPersistence = 150; // ms user must be at top before next scroll up triggers the button

                const showButton = () => {
                    if (App.state.previousBestPassesLoaded || !showPreviousContainer.classList.contains('hidden')) return;
                    showPreviousContainer.classList.remove('hidden');
                    void showPreviousContainer.offsetWidth; // Force reflow
                    showPreviousContainer.style.transform = 'translateY(0)';
                    showPreviousContainer.style.opacity = '1';
                };

                const hideButton = () => {
                    if (showPreviousContainer.classList.contains('hidden')) return;
                    showPreviousContainer.style.transform = 'translateY(-100%)';
                    showPreviousContainer.style.opacity = '0';
                    setTimeout(() => {
                        showPreviousContainer.classList.add('hidden');
                    }, 300);
                };

                bestPassesScroller.addEventListener('wheel', (e) => {
                    if (e.deltaY < -10 && bestPassesScroller.scrollTop === 0) { // Scrolling up at the top
                        if (atTopSince > 0 && (Date.now() - atTopSince > requiredPersistence)) {
                            showButton();
                            atTopSince = 0; // Reset after showing
                        }
                    }
                }, { passive: true });
                
                bestPassesScroller.addEventListener('touchstart', (e) => {
                    touchStartY = e.touches[0].clientY;
                    isDragging = true;
                }, { passive: true });
                
                bestPassesScroller.addEventListener('touchmove', (e) => {
                    if (!isDragging) return;
                    const currentY = e.touches[0].clientY;
                    if (currentY > touchStartY + 10 && bestPassesScroller.scrollTop === 0) { // Swiping down (scrolling up) at the top
                         if (atTopSince > 0 && (Date.now() - atTopSince > requiredPersistence)) {
                            showButton();
                            atTopSince = 0; // Reset after showing
                        }
                    }
                }, { passive: true });
                
                bestPassesScroller.addEventListener('touchend', () => {
                    isDragging = false;
                    // Reset on touch end to require a new "rest" at the top for the next gesture
                    if (bestPassesScroller.scrollTop === 0) {
                        atTopSince = Date.now();
                    } else {
                        atTopSince = 0;
                    }
                });

                bestPassesScroller.addEventListener('scroll', () => {
                    if (bestPassesScroller.scrollTop === 0) {
                        if (atTopSince === 0) { // Just arrived at top
                            atTopSince = Date.now();
                        }
                    } else {
                        atTopSince = 0; // Not at top
                        hideButton();
                    }
                });
            }
            // --- FIN: Lógica para mostrar/ocultar botón de pasos previos ---

			elements.knownSatellitesList.addEventListener('click', (e) => {
				const satCard = e.target.closest('.satellite-entry');
				if (!satCard) return;
			
				const favBtn = e.target.closest('.favorite-btn');
				if (favBtn) {
					e.stopPropagation();
					const satId = favBtn.dataset.satId;
					const satData = App.config.knownSatellites[satId];
					if (satData) {
						this.mySatellites.handleFavoriteClick(satData.name, satData.tle);
					}
				} else {
					this.satellites.loadKnown(satCard.dataset.satId);
				}
			});

			elements.brightestSatellitesList.addEventListener('click', (e) => {
				const satCard = e.target.closest('.satellite-entry');
				if (!satCard) return;
		
				const favBtn = e.target.closest('.favorite-btn');
				if (favBtn) {
					e.stopPropagation();
					const name = favBtn.dataset.name;
					const tle = favBtn.dataset.tle;
					this.mySatellites.handleFavoriteClick(name, tle);
				} else {
					this.mySatellites.handleTrack(satCard.dataset.tle);
				}
			});

			elements.settingMapDark.addEventListener('click', () => this.settings.setMapMode('dark'));
			elements.settingMapSatellite.addEventListener('click', () => this.settings.setMapMode('satellite'));

			elements.settingDayNightOn.addEventListener('click', () => this.settings.setDefaultNightOverlay(true));
			elements.settingDayNightOff.addEventListener('click', () => this.settings.setDefaultNightOverlay(false));

			const { languageDropdownToggle, languageDropdownMenu } = elements;
			if (languageDropdownToggle && languageDropdownMenu) {
				languageDropdownToggle.addEventListener('click', (e) => {
					e.stopPropagation(); 
					languageDropdownMenu.classList.toggle('visible');
				});

				languageDropdownMenu.addEventListener('click', (e) => {
					const button = e.target.closest('.dropdown-item');
					if (button && button.dataset.lang) {
						this.settings.setLanguage(button.dataset.lang);
						languageDropdownMenu.classList.remove('visible');
					}
				});
			}
			
            const setupFilter = (containerId, onFilterChange) => {
                const container = document.getElementById(containerId);
                if (!container) return;

                const pillBtn = container.querySelector('.filter-pill-btn');
                const menu = container.querySelector('.filter-menu');
                const label = pillBtn.querySelector('span');
                const dropdown = container.querySelector('.filter-dropdown');

                pillBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const currentlyOpen = dropdown.classList.contains('is-open');

                    // Cierra todos los otros pop-ups de filtros
                    document.querySelectorAll('.filter-dropdown.is-open').forEach(d => {
                        if (d !== dropdown) {
                            d.classList.remove('is-open');
                            d.querySelector('.filter-menu')?.classList.add('hidden');
                        }
                    });

                    // Abre o cierra el actual
                    dropdown.classList.toggle('is-open', !currentlyOpen);
                    menu.classList.toggle('hidden', currentlyOpen);
                });

                menu.addEventListener('click', (e) => {
                    const filterBtn = e.target.closest('.filter-btn');
                    if (filterBtn) {
                        const filterValue = filterBtn.dataset.filter;
                        
                        // Determinar qué estado actualizar basado en el ID del contenedor
                        if (containerId === 'best-passes-filter-container') {
                            this.state.currentPassFilter = filterValue;
                        } else if (containerId === 'best-passes-source-filter-container') {
                            this.state.currentBestPassesSource = filterValue;
                        } else {
                            this.state.currentPassFilter = filterValue; // Fallback para el modal
                        }

                        menu.querySelectorAll('.filter-btn.active').forEach(b => b.classList.remove('active'));
                        filterBtn.classList.add('active');
                        
                        if (filterValue === 'all') {
                            if (containerId === 'best-passes-source-filter-container') {
                                label.textContent = App.language.getTranslation('allSatellites');
                            } else {
                                label.textContent = App.language.getTranslation('filterAll');
                            }
                        } else {
                            label.textContent = filterBtn.textContent;
                        }
                        
                        dropdown.classList.remove('is-open');
                        menu.classList.add('hidden');
                        
                        onFilterChange();
                    }
                });
            };

            setupFilter('best-passes-filter-container', () => this.prediction.renderFilteredPasses());
            
            setupFilter('best-passes-source-filter-container', () => {
                App.state.passCalculation.allFoundPasses = []; // Limpia el estado en memoria para forzar una recarga.
                sessionStorage.clear(); // Opcional pero recomendado: limpia toda la caché de sesión para asegurar datos frescos.
                this.prediction.showBestPasses();
            });

            setupFilter('passes-modal-filter-container', () => this.prediction.displayPasses(this.state.passCalculation.allFoundPasses, false));


			document.addEventListener('click', (e) => {
				if (elements.languageDropdownMenu && elements.languageDropdownMenu.classList.contains('visible')) {
					elements.languageDropdownMenu.classList.remove('visible');
				}
				document.querySelectorAll('.filter-dropdown.is-open').forEach(dropdown => {
					if (!dropdown.contains(e.target)) {
						dropdown.classList.remove('is-open');
						dropdown.querySelector('.filter-menu')?.classList.add('hidden');
					}
				});
				if (elements.searchContainerKnown && !elements.searchContainerKnown.contains(e.target)) {
					elements.searchContainerKnown.classList.remove('is-active');
				}
			});

			const setupExpandableSearch = (containerId, buttonId, inputId) => {
				const container = document.getElementById(containerId);
				const button = document.getElementById(buttonId);
				const input = document.getElementById(inputId);

				if (container && button && input) {
					button.addEventListener('click', (e) => {
						e.stopPropagation();
						container.classList.toggle('is-active');
						if (container.classList.contains('is-active')) {
							input.focus();
						}
					});
				}
			};
			setupExpandableSearch('search-container-known', 'search-toggle-btn-known', 'known-satellites-search-input');
			setupExpandableSearch('search-container-favorites', 'search-toggle-btn-favorites', 'favorite-satellites-search-input');


			// Función genérica para filtrar listas de satélites
			const setupSatelliteSearch = (inputId, listId) => {
				const searchInput = document.getElementById(inputId);
				const satelliteList = document.getElementById(listId);
				if (!searchInput || !satelliteList) return;

				searchInput.addEventListener('input', () => {
					const searchTerm = searchInput.value.toLowerCase().trim();
					const satelliteCards = satelliteList.querySelectorAll('.satellite-entry');
					
					satelliteCards.forEach(card => {
						const satelliteName = card.querySelector('h3')?.textContent.toLowerCase() || '';
						const isVisible = satelliteName.includes(searchTerm);
						card.classList.toggle('hidden', !isVisible);
					});
				});
			};

			// Aplicar la función a las dos pantallas
			setupSatelliteSearch('known-satellites-search-input', 'known-satellites-list');
			setupSatelliteSearch('brightest-satellites-search-input', 'brightest-satellites-list');
			setupSatelliteSearch('favorite-satellites-search-input', 'favorite-satellites-list-known-screen');

            elements.dailyUpdatePill.addEventListener('click', () => {
                this.playSound('uiClick', 'E4');
                this.ui.showDailyUpdateModal(true);
            });

            elements.dailyUpdateModal.addEventListener('click', (e) => {
                if (e.target.id === 'daily-update-modal') {
                    this.playSound('uiClick', 'A3');
                    this.ui.showDailyUpdateModal(false);
                }
            });
            
            elements.closeDailyUpdateModalBtn.addEventListener('click', () => {
                this.playSound('uiClick', 'A3');
                this.ui.showDailyUpdateModal(false);
            });

			elements.closeDailyUpdateModalBtn.addEventListener('click', () => {
                this.playSound('uiClick', 'A3');
                this.ui.showDailyUpdateModal(false);
            });

            elements.backToStartFromEventsBtn.addEventListener('click', () => { this.playSound('uiClick', 'A3'); history.back(); });

			// --- INICIO: Lógica para la barra de navegación inferior ---
			elements.navBtnHome.addEventListener('click', () => {
                this.playSound('uiClick', 'C4');
                this.navigation.go('start-screen');
            });
            elements.navBtnEvents.addEventListener('click', () => {
                this.playSound('uiClick', 'C#4');
                this.navigation.go('events-screen', { hideBackButton: true });
            });
            elements.navBtnMoon.addEventListener('click', () => {
                this.playSound('uiClick', 'D4');
                this.navigation.go('info-screen-moon', { hideBackButton: true });
            });
elements.navBtnMenu.addEventListener('click', () => {
                        this.playSound('uiClick', 'E4');
                        this.navigation.go('menu-screen', { hideBackButton: true });
                    });
			// --- FIN: Lógica para la barra de navegación inferior ---

			elements.toggleNightOverlayBtn.addEventListener('change', (e) => {
				App.settings.setNightOverlay(e.target.checked);
			});

			// --- INICIO: Corrección para el estado "activo" persistente de los botones ---
			let pressedElement = null;

			// Función centralizada para limpiar el estado presionado y remover los listeners globales.
			function clearPressedState() {
				if (pressedElement) {
					pressedElement.classList.remove('is-pressed');
					pressedElement = null;
				}
				// Se remueven los listeners del documento para evitar acumulación y ejecuciones innecesarias.
				document.removeEventListener('mouseup', clearPressedState);
				document.removeEventListener('touchend', clearPressedState);
				document.removeEventListener('touchcancel', clearPressedState);
				document.removeEventListener('mousemove', handleMove);
				document.removeEventListener('touchmove', handleMove);
			}

			// Maneja el movimiento del puntero (mouse o dedo).
			function handleMove(event) {
				if (!pressedElement) return;

				const x = event.clientX ?? event.touches?.[0]?.clientX;
				const y = event.clientY ?? event.touches?.[0]?.clientY;

				// Si no hay coordenadas (el toque terminó), se limpia el estado.
				if (x === undefined || y === undefined) {
					clearPressedState();
					return;
				}

				const elementAtPoint = document.elementFromPoint(x, y);
				
				// Si el puntero ya no está sobre el elemento presionado, se limpia el estado.
				if (!pressedElement.contains(elementAtPoint)) {
					clearPressedState();
				}
			}
			
			// Listener principal que inicia la interacción en el documento.
			function handleInteractionStart(event) {
				// Se limpia cualquier estado anterior por si quedó "pegado".
				clearPressedState();
				
				const target = event.target.closest('.btn, .menu-list-item, .nav-item, .satellite-nav-btn, .modal-satellite-card, .pass-card-clickable, .satellite-entry-clickable');
				
				if (target) {
					pressedElement = target;
					pressedElement.classList.add('is-pressed');

					// Una vez que se presiona un elemento, se activan los listeners globales
					// para detectar cuándo y dónde se suelta o se mueve el puntero.
					document.addEventListener('mouseup', clearPressedState);
					document.addEventListener('touchend', clearPressedState);
					document.addEventListener('touchcancel', clearPressedState);
					document.addEventListener('mousemove', handleMove);
					document.addEventListener('touchmove', handleMove, { passive: true });
				}
			}

			// Se asignan los listeners iniciales para mousedown y touchstart.
			document.addEventListener('mousedown', handleInteractionStart, { passive: true });
			document.addEventListener('touchstart', handleInteractionStart, { passive: true });
			// --- FIN: Corrección para el estado "activo" persistente de los botones ---
		},
		openMapAndTrackDefault() {
			this.playSound('uiClick', 'C4');
			this.navigation.go('app-container');

			const checkMapAndLoad = (attempts = 20) => {
				if (this.state.mapInitialized && this.state.map) {
					const lastSatTle = localStorage.getItem(this.config.lastSatStorageKey);
					if (lastSatTle) {
						if (!lastSatTle.startsWith("ALL_SATS_MODE::")) {
							this.mySatellites.handleTrack(lastSatTle, true);
						}
					} else {
						const tryLoadIss = (issAttempts = 10) => {
							const satData = this.config.knownSatellites['iss'];
							if (satData && satData.tle) {
								this.mySatellites.handleTrack(satData.tle, true);
							} else if (issAttempts > 0) {
								setTimeout(() => tryLoadIss(issAttempts - 1), 200);
							} else {
								console.error("No se pudo cargar el TLE de la ISS.");
								this.playSound('error', 'D3');
							}
						};
						tryLoadIss();
					}
				} else if (attempts > 0) {
					setTimeout(() => checkMapAndLoad(attempts - 1), 100);
				} else {
					console.error("El mapa no se inicializó a tiempo.");
				}
			};
			checkMapAndLoad();
		},
		playSound(soundKey, note) { 
			return;
		},

		nightOverlay: {
			init() {
				if (!App.state.map) return;
				// Pane para la sombra de la noche para controlar su z-index
				App.state.map.createPane('nightOverlayPane');
				App.state.map.getPane('nightOverlayPane').style.zIndex = 410; // Debajo de los marcadores pero encima de los tiles
				App.state.nightOverlayLayer = L.layerGroup([], { pane: 'nightOverlayPane' }).addTo(App.state.map);
				this.update();
			},
	
			getSunPosition(time) {
				const sunEci = getSunEci(time);
				const gmst = satellite.gstime(time);
				const sunGeodetic = satellite.eciToGeodetic(sunEci, gmst);
				return {
					lat: satellite.radiansToDegrees(sunGeodetic.latitude),
					lon: satellite.radiansToDegrees(sunGeodetic.longitude)
				};
			},
	
			update() {
				if (!App.state.map || !App.state.nightOverlayLayer) return;
	
				App.state.nightOverlayLayer.clearLayers();
                
				if (!App.settings.current.showNightOverlay) {
					return;
				}

				const time = App.state.currentTime;
				const sunPos = this.getSunPosition(time);
	
				const terminatorPoints = [];
				for (let i = 0; i <= 360; i += 2) {
					const lon = sunPos.lon + i - 180;
					// Evita la división por cero en los polos
					const tanLat = Math.tan(satellite.degreesToRadians(sunPos.lat));
					if (Math.abs(tanLat) < 1e-6) {
						terminatorPoints.push([0, lon]);
						continue;
					}
					const lat = -Math.atan(Math.cos(satellite.degreesToRadians(lon - sunPos.lon)) / tanLat);
					terminatorPoints.push([satellite.radiansToDegrees(lat), lon]);
				}
	
				const northPoleIsDark = sunPos.lat < 0;
				const poleLat = northPoleIsDark ? 90.0 : -90.0;
	
				const nightPolygonCoords = [
					...terminatorPoints,
					[poleLat, terminatorPoints[terminatorPoints.length - 1][1]],
					[poleLat, terminatorPoints[0][1]]
				];
	
				const offsets = [-720, -360, 0, 360, 720];
				offsets.forEach(offset => {
					const shiftedPolygon = nightPolygonCoords.map(p => [p[0], p[1] + offset]);
					L.polygon(shiftedPolygon, { className: 'night-overlay', smoothFactor: 1 }).addTo(App.state.nightOverlayLayer);
				});
			}
		},

		nearbyMode: {
			toggle() {
				if (App.state.isNearbyModeActive) {
					this.stop();
				} else {
					this.start();
				}
			},
		
			start() {
				if (!App.state.observerCoords) {
					App.ui.showToast(App.language.getTranslation('setLocationForBestPasses'), 'error');
					return;
				}
		
				App.playSound('uiClick', 'E4');
				App.state.isNearbyModeActive = true;
				App.elements.nearbyButton.classList.add('active');
		
				const panel = App.elements.mainControlPanel;
				if (!panel.classList.contains('expanded')) {
					panel.classList.add('expanded');
				}
				panel.classList.add('show-compass');
				App.ui.updatePageIndicator(true);
				App.radar.start('radar-canvas', 'radar-pointer');
		
				App.satellites.clearMapLayers();
				App.prediction.clearVisibilityBands();
				App.elements.mainControlPanel.classList.remove('satellite-loaded');
				App.state.trackedSatellites = [];
		
				this.drawRadiusAndMask();
				this.gatherSatellites();
				this.update(); 
				App.state.nearby.updateInterval = setInterval(() => this.update(), 1000); 
			},
		
			stop() {
				App.playSound('uiClick', 'A3');
				App.state.isNearbyModeActive = false;
				App.elements.nearbyButton.classList.remove('active');
		
				const panel = App.elements.mainControlPanel;
				panel.classList.remove('show-compass');
				App.ui.updatePageIndicator(false);
				App.radar.stop();
		
				if (App.state.nearby.updateInterval) {
					clearInterval(App.state.nearby.updateInterval);
					App.state.nearby.updateInterval = null;
				}
				this.clearNearbyLayers();
				App.state.nearby.allSats = [];
				App.state.nearby.selectedSatForOrbit = null; // Limpiar satélite seleccionado
		
				App.satellites.handleTleLoad(true);
				App.satellites.handleTracking();
				App.satellites.centerOnSatellite();
			},
		
			clearNearbyLayers() {
				const { map, nearby } = App.state;
				if (!map) return;
		
				if (nearby.circle) map.removeLayer(nearby.circle);
				if (nearby.mask) map.removeLayer(nearby.mask);
				nearby.satellites.forEach(sat => {
					if (sat.marker) map.removeLayer(sat.marker);
					if (sat.orbitLayers) {
						sat.orbitLayers.forEach(layer => map.removeLayer(layer));
					}
				});
		
				nearby.circle = null;
				nearby.mask = null;
				nearby.satellites = [];
			},
		
			drawRadiusAndMask() {
				const { map, observerCoords, nearby } = App.state;
				if (!map || !observerCoords) return;
				const radiusKm = 1200;
				nearby.circle = L.circle(observerCoords, { radius: radiusKm * 1000, color: 'rgba(88, 166, 255, 0.8)', weight: 2, fill: false, className: 'nearby-radius-circle' }).addTo(map);
				const worldBounds = [ [-90, -180], [90, -180], [90, 180], [-90, 180] ];
				const circleLatLngs = this.getCircleLatLngs(observerCoords, radiusKm);
				nearby.mask = L.polygon([worldBounds, circleLatLngs], { color: 'transparent', fillColor: '#0D1117', fillOpacity: 0.5, className: 'nearby-mask-overlay' }).addTo(map);
				
				const panelHeight = App.elements.mainControlPanel.offsetHeight;
				const topPadding = panelHeight + 20; // Sumamos 20px de margen

				map.fitBounds(nearby.circle.getBounds(), { 
					paddingTopLeft: [50, topPadding],
					paddingBottomRight: [50, 50]
				});
			},
		
			getCircleLatLngs(center, radiusKm) {
				const latlngs = [];
				const R = 6371;
				const d = radiusKm / R;
				for (let i = 0; i <= 360; i++) {
					const brng = satellite.degreesToRadians(i);
					let latRad = Math.asin(Math.sin(satellite.degreesToRadians(center[0])) * Math.cos(d) + Math.cos(satellite.degreesToRadians(center[0])) * Math.sin(d) * Math.cos(brng));
					let lonRad = satellite.degreesToRadians(center[1]) + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(satellite.degreesToRadians(center[0])), Math.cos(d) - Math.sin(satellite.degreesToRadians(center[0])) * Math.sin(latRad));
					latlngs.push([satellite.radiansToDegrees(latRad), satellite.radiansToDegrees(lonRad)]);
				}
				return latlngs;
			},
		
			_getIntersectionPoint(p1, p2, center, radius) {
				const d1 = this.calculateDistance(p1.lat, p1.lon, center[0], center[1]);
				const d2 = this.calculateDistance(p2.lat, p2.lon, center[0], center[1]);
				const t = (radius - d1) / (d2 - d1);
				return {
					lat: p1.lat + t * (p2.lat - p1.lat),
					lon: p1.lon + t * (p2.lon - p1.lon),
					time: new Date(p1.time.getTime() + t * (p2.time.getTime() - p1.time.getTime())),
					position: {
						x: p1.position.x + t * (p2.position.x - p1.position.x),
						y: p1.position.y + t * (p2.position.y - p1.position.y),
						z: p1.position.z + t * (p2.position.z - p1.position.z),
					}
				};
			},

			gatherSatellites() {
				if (App.state.nearby.allSats.length > 0) return;
				const allSatsMap = new Map();
				const addSat = (sat) => {
					if (!sat || !sat.tle) return;
					const parsedList = App.satellites.parseTLE(sat.tle);
					if (parsedList.length === 0) return;
					const parsed = parsedList[0];
					const tleId = getTleId(sat.tle);
					if (tleId && !allSatsMap.has(tleId)) {
						try {
							const satrec = satellite.twoline2satrec(parsed.line1, parsed.line2);
							allSatsMap.set(tleId, { name: parsed.name, tle: sat.tle, satrec });
						} catch (e) { /* Ignorar TLEs inválidos */ }
					}
				};
				Object.values(App.config.knownSatellites).forEach(addSat);
				App.mySatellites.loadFromStorage().forEach(addSat);
				App.config.latestStarlinks.forEach(addSat);
				App.config.brightestSatellites.forEach(addSat);
				App.state.nearby.allSats = Array.from(allSatsMap.values());
			},
		
			update() {
				if (!App.state.isNearbyModeActive) return;
				
				if (!App.state.isTimeTraveling) {
					App.state.currentTime = new Date();
				}

				const { observerCoords, nearby, map, currentTime } = App.state;
				if (!observerCoords) return;
		
				const radiusKm = 1200;
				const now = currentTime;
				const currentlyNearbyIds = new Set();
				const observerGd = { latitude: satellite.degreesToRadians(observerCoords[0]), longitude: satellite.degreesToRadians(observerCoords[1]), height: 0.1 };
		
				nearby.allSats.forEach(sat => {
					let posGd, posVel, gmst, isVisible = false;
					try {
						posVel = satellite.propagate(sat.satrec, now);
						gmst = satellite.gstime(now);
						posGd = satellite.eciToGeodetic(posVel.position, gmst);

						const posEcf = satellite.eciToEcf(posVel.position, gmst);
						const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
						const elevation = satellite.radiansToDegrees(lookAngles.elevation);

						if (elevation > 10) {
							const isObserverDark = App.prediction._isObserverInDarkness(now, observerCoords);
							const isSatInSunlight = App.prediction.isSatIlluminated(posVel.position, now);
							isVisible = isObserverDark && isSatInSunlight;
						}
					} catch (e) { return; }
		
					const lat = satellite.radiansToDegrees(posGd.latitude);
					const lon = satellite.radiansToDegrees(posGd.longitude);
					const distance = this.calculateDistance(observerCoords[0], observerCoords[1], lat, lon);
		
					if (distance <= radiusKm) {
						const tleId = getTleId(sat.tle);
						currentlyNearbyIds.add(tleId);
						const existingSat = nearby.satellites.find(s => getTleId(s.tle) === tleId);
		
						if (existingSat) {
							let bearing = existingSat.lastBearing || 0;
							try {
								const futurePosVel = satellite.propagate(sat.satrec, new Date(now.getTime() + 1000));
								const futureGmst = satellite.gstime(new Date(now.getTime() + 1000));
								const futurePosGd = satellite.eciToGeodetic(futurePosVel.position, futureGmst);
								const futurePoint = [satellite.radiansToDegrees(futurePosGd.latitude), satellite.radiansToDegrees(futurePosGd.longitude)];
								if (Math.abs(lon - futurePoint[1]) < 180) bearing = calculateBearing([lat, lon], futurePoint);
								existingSat.lastBearing = bearing;
							} catch(e) {}
							existingSat.marker.setLatLng([lat, lon]);
							const iconEl = existingSat.marker._icon;
							if (iconEl) {
								const wrapper = iconEl.querySelector('.satellite-marker-wrapper');
								wrapper.style.transform = `rotate(${bearing}deg)`;
								wrapper.classList.toggle('is-not-visible', !isVisible);

								const tooltipEl = existingSat.marker.getTooltip()?.getElement();
								if (tooltipEl) {
									tooltipEl.classList.toggle('is-not-visible', !isVisible);
								}
							}
						} else {
							const visibilityClass = isVisible ? '' : ' is-not-visible';
							const icon = L.divIcon({ className: '', html: `<div class="satellite-marker-wrapper${visibilityClass}"><svg width="22" height="22" viewBox="0 0 24 24" class="satellite-triangle-icon"><polygon points="12,2 20,22 4,22" stroke="rgba(255,255,255,0.8)" stroke-width="1.5" /></svg></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
							const marker = L.marker([lat, lon], { icon }).addTo(map);
							const tooltipClassName = `satellite-label ${!isVisible ? 'is-not-visible' : ''}`;
							
							// Se modifica el contenido del tooltip para que sea idéntico al del modo normal
							marker.bindTooltip(`<span class="sat-name-span" data-tle-id='${getTleId(sat.tle)}'>${sat.name}</span><i class="fa-solid fa-circle-info sat-info-icon" data-tle-id='${getTleId(sat.tle)}'></i>`, { permanent: true, direction: 'right', offset: [15, 0], className: tooltipClassName, interactive: true });
							
							// El clic en el marcador (triángulo) sigue trazando la órbita en el modo Cerca
							marker.on('click', () => { App.playSound('uiClick', 'E4'); this.drawOrbitForNearbySat(sat); });
							nearby.satellites.push({ ...sat, marker, lastBearing: 0, orbitLayers: [] });
						}
					}
				});
		
				nearby.satellites = nearby.satellites.filter(sat => {
					if (!currentlyNearbyIds.has(getTleId(sat.tle))) {
						map.removeLayer(sat.marker);
						if (sat.orbitLayers) sat.orbitLayers.forEach(layer => map.removeLayer(layer));
						return false;
					}
					return true;
				});
		
				// Actualizar la órbita del satélite seleccionado
				const selectedSatTleId = nearby.selectedSatForOrbit ? getTleId(nearby.selectedSatForOrbit.tle) : null;
		
				nearby.satellites.forEach(sat => {
					if (getTleId(sat.tle) === selectedSatTleId) {
						// Este es el satélite seleccionado, dibujar su órbita cortada y con visibilidad
						if (sat.orbitLayers) {
							sat.orbitLayers.forEach(layer => map.removeLayer(layer));
						}
						sat.orbitLayers = [];
		
						const period = (2 * Math.PI) / sat.satrec.no;
						const step = period / 240; // Mayor resolución para cortes más precisos
						const masterPath = [];
						let lastLon = null;
						const orbitBaseTime = App.state.isTimeTraveling ? currentTime : now;
		
						for (let i = 0; i <= period * 1.01; i += step) {
							const time = new Date(orbitBaseTime.getTime() + i * 60000);
							try {
								const posVel = satellite.propagate(sat.satrec, time);
								const gmst = satellite.gstime(time);
								const posGd = satellite.eciToGeodetic(posVel.position, gmst);
								let lon = satellite.radiansToDegrees(posGd.longitude);
								if (lastLon !== null) {
									while (lon - lastLon > 180) lon -= 360;
									while (lon - lastLon < -180) lon += 360;
								}
								lastLon = lon;
								masterPath.push({
									lat: satellite.radiansToDegrees(posGd.latitude),
									lon: lon,
									time: time,
									position: posVel.position
								});
							} catch (e) { continue; }
						}
						
						if (masterPath.length >= 2) {
							const offsets = [0, 360, -360, 720, -720];
							const radiusKm = 1200;
							let currentSegment = [];
		
							const drawSegment = (segment) => {
								if (segment.length < 2) return;
								const isVisible = segment[0].isVisible;
								const options = { className: isVisible ? 'orbit-path' : 'orbit-path-shadow', pane: 'trajectoryPane' };
								offsets.forEach(offset => {
									const offsetPath = segment.map(p => [p.lat, p.lon + offset]);
									sat.orbitLayers.push(L.polyline(offsetPath, options).addTo(map));
								});
							};
		
							for (let i = 0; i < masterPath.length - 1; i++) {
								const p1 = masterPath[i];
								const p2 = masterPath[i+1];
		
								const p1_inside = this.calculateDistance(p1.lat, p1.lon, observerCoords[0], observerCoords[1]) <= radiusKm;
								const p2_inside = this.calculateDistance(p2.lat, p2.lon, observerCoords[0], observerCoords[1]) <= radiusKm;
		
								const p1_isVisible = App.prediction._isObserverInDarkness(p1.time, observerCoords) && App.prediction.isSatIlluminated(p1.position, p1.time);
								p1.isVisible = p1_isVisible;

								if (p1_inside) {
									if (currentSegment.length === 0 || currentSegment[0].isVisible === p1_isVisible) {
										currentSegment.push(p1);
									} else {
										drawSegment(currentSegment);
										currentSegment = [currentSegment[currentSegment.length - 1], p1];
									}
								}
		
								if (p1_inside !== p2_inside) {
									const intersection = this._getIntersectionPoint(p1, p2, observerCoords, radiusKm);
									intersection.isVisible = App.prediction._isObserverInDarkness(intersection.time, observerCoords) && App.prediction.isSatIlluminated(intersection.position, intersection.time);
		
									if (currentSegment.length > 0 && currentSegment[0].isVisible !== intersection.isVisible) {
										drawSegment(currentSegment);
										currentSegment = [];
									}
									currentSegment.push(intersection);
									drawSegment(currentSegment);
									currentSegment = [];
								}
							}
							drawSegment(currentSegment);
						}
		
					} else {
						// Este satélite no está seleccionado, asegurar que no tenga órbita visible
						if (sat.orbitLayers && sat.orbitLayers.length > 0) {
							sat.orbitLayers.forEach(layer => map.removeLayer(layer));
							sat.orbitLayers = [];
						}
					}
				});
		
				if (App.radar.isSensorActive) {
					App.radar.drawRadarContent();
				}
			},
		
			drawOrbitForNearbySat(clickedSat) {
				const { nearby } = App.state;
				const clickedSatTleId = getTleId(clickedSat.tle);
				const isAlreadySelected = nearby.selectedSatForOrbit && getTleId(nearby.selectedSatForOrbit.tle) === clickedSatTleId;
			
				if (isAlreadySelected) {
					// Si se hace clic en el mismo satélite, se deselecciona. La limpieza la hará el loop de update.
					nearby.selectedSatForOrbit = null;
				} else {
					// Selecciona el nuevo satélite. El dibujado lo hará el loop de update.
					const existingSat = nearby.satellites.find(s => getTleId(s.tle) === clickedSatTleId);
					nearby.selectedSatForOrbit = existingSat;
				}
			},
		
			calculateDistance(lat1, lon1, lat2, lon2) {
				const R = 6371;
				const dLat = satellite.degreesToRadians(lat2 - lat1);
				const dLon = satellite.degreesToRadians(lon2 - lon1);
				const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(satellite.degreesToRadians(lat1)) * Math.cos(satellite.degreesToRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
				const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
				return R * c;
			}
		},

		navigation: {
			init() {
				window.addEventListener('popstate', (event) => {
					const modals = [App.elements.tleModal, App.elements.passesModal, App.elements.confirmModal, App.elements.favoritesModal, App.elements.satelliteInfoModal, App.elements.radarModal, App.elements.socialModal, App.elements.notificationModal];
					const visibleModal = modals.find(m => m && m.classList.contains('is-visible'));

					// Primero, se verifica si hay un modal abierto. Si es así, se cierra.
					// Esta es la acción principal para "history.back()" cuando un modal está activo.
					if (visibleModal) {
						if (visibleModal.id === 'radar-modal') {
							App.radar.stop();
							if (App.elements.mainControlPanel.classList.contains('show-compass')) {
								App.radar.start('radar-canvas', 'radar-pointer');
							}
						}
                        if (visibleModal.id === 'passes-modal') {
                            App.prediction.stopPassCalculation();
                        }
						if (visibleModal.id === 'favorites-modal' && App.state.isMultiSelectMode) {
							App.mySatellites.toggleMultiSelectMode(false);
						}
						App.ui.hideModal(visibleModal, true);
						return; // Importante: termina la ejecución para no procesar otras lógicas de navegación.
					}

					const isMapScreenVisible = App.elements.appContainer && !App.elements.appContainer.classList.contains('hidden');
					
					// Si no hay modales abiertos y se está en modo "Cerca", entonces sí se sale de ese modo.
					if (isMapScreenVisible && App.state.isNearbyModeActive) {
						App.nearbyMode.stop();
						history.pushState({ screen: 'app-container' }, '', '#app-container');
						return;
					}
					
					// Lógica de navegación entre pantallas si no hay modales ni modos especiales activos.
					if (event.state && event.state.screen) {
						this.renderScreen(event.state.screen, false);
					} else {
						this.renderScreen('start-screen', false);
					}
				});

				const initialScreenId = 'start-screen';
				history.replaceState({ screen: initialScreenId }, '', `#${initialScreenId}`);
				this.renderScreen(initialScreenId, false);
			},
			go(screenId, options = {}) {
				const currentState = history.state;
				if (!currentState || currentState.screen !== screenId) {
					history.pushState({ screen: screenId, ...options }, '', `#${screenId}`);
					this.renderScreen(screenId, true);
				}
			},
			renderScreen(screenId, animate = true) {
				const screens = [ App.elements.startScreen, App.elements.knownSatellitesScreen, App.elements.appContainer, App.elements.mySatellitesScreen, App.elements.bestPassesScreen, App.elements.brightestSatellitesScreen, App.elements.infoScreenAbout, App.elements.infoScreenGuide, App.elements.infoScreenLegal, App.elements.infoScreenSettings, App.elements.latestStarlinksScreen, App.elements.infoScreenMoon, App.elements.menuScreen, App.elements.eventsScreen ];
				const currentVisibleScreen = screens.find(s => s && !s.classList.contains('hidden'));
				const targetScreen = document.getElementById(screenId); 
				if (!targetScreen) return;
				if (currentVisibleScreen && currentVisibleScreen.id === screenId) return;

                // Lógica para mostrar/ocultar botones de retroceso según el origen de la navegación
                const stateOptions = history.state || {};
                const { backToStartFromMoonBtn, backToStartFromMenuBtn, backToStartFromEventsBtn } = App.elements;

                if (screenId === 'info-screen-moon' && backToStartFromMoonBtn) {
                    backToStartFromMoonBtn.classList.toggle('hidden', !!stateOptions.hideBackButton);
                }
                if (screenId === 'menu-screen' && backToStartFromMenuBtn) {
                    backToStartFromMenuBtn.classList.toggle('hidden', !!stateOptions.hideBackButton);
                }
                if (screenId === 'events-screen' && backToStartFromEventsBtn) {
                    backToStartFromEventsBtn.classList.toggle('hidden', !!stateOptions.hideBackButton);
                }

                App.prediction.stopPassCalculation();

                if (screenId === 'best-passes-screen') {
                    App.ui.showLoadingModal('calculatingBestPasses');
                }

				if (App.elements.hamburgerBtn) {
					const isSocialModalVisible = App.elements.socialModal && App.elements.socialModal.classList.contains('is-visible');
					App.elements.hamburgerBtn.classList.toggle('hidden', screenId !== 'start-screen' || isSocialModalVisible);
				}

				document.body.classList.toggle('map-active', screenId === 'app-container');

				const cleanupAndShowNext = () => {
					if (currentVisibleScreen && currentVisibleScreen.id === 'app-container' && screenId !== 'app-container') {
						App.time.stopTimeTravel(); 
						if (App.state.trackedSatellites.length > 1) {
							localStorage.removeItem(App.config.lastSatStorageKey);
						}
						App.radar.stop();
						if (App.state.map) {
							App.state.map.remove();
							App.state.map = null;
							App.state.mapInitialized = false;
						}
					}

					screens.forEach(s => s.classList.add('hidden'));
					
					targetScreen.classList.remove('hidden', 'screen-enter-active', 'screen-exit-active');
					if (animate) {
						targetScreen.classList.add('screen-enter-active');
						targetScreen.addEventListener('animationend', () => {
							targetScreen.classList.remove('screen-enter-active');
						}, { once: true });
					}
					
					if (screenId === 'app-container') { 
						App.elements.mainControlPanel.classList.add('expanded');
						App.elements.mainControlPanel.classList.remove('show-compass'); 
						App.elements.timeControlPanel.classList.remove('visible'); 
						if (!App.state.mapInitialized) App.initMap(); 
						
						setTimeout(() => {
							if (!App.state.map) return; 
							App.state.map.invalidateSize(false); 

							if (App.state.trackedSatellites.length > 0) {
								App.satellites.handleTracking(true);
								
								if (App.state.pendingPassJumpTimestamp) {
									App.prediction.jumpToPassTime(App.state.pendingPassJumpTimestamp);
									App.state.pendingPassJumpTimestamp = null;
								} else {
									setTimeout(() => App.satellites.centerOnSatellite(), 50);
								}
							}
							App.location.applySavedLocationToMap();
						}, 300); 
					} 
					else if (screenId === 'my-satellites-screen') { App.mySatellites.renderList(); }
					else if (screenId === 'best-passes-screen') {
						App.prediction.showBestPasses();
                    }
					else if (screenId === 'known-satellites-screen') { App.mySatellites.renderFavoriteSatellitesOnKnownScreen(); App.mySatellites.updateFavoriteIcons(); }
					else if (screenId === 'brightest-satellites-screen') { App.mySatellites.renderBrightestSatellites(); }
					else if (screenId === 'latest-starlinks-screen') { App.starlinks.showScreen(); }
					else if (screenId === 'info-screen-settings') { App.settings.updateUI(); }
					else if (screenId === 'info-screen-moon') { App.moon.showScreen(); }

					// --- INICIO: Actualizar estado de la barra de navegación inferior ---
					const navItems = App.elements.bottomNavBar.querySelectorAll('.nav-item');
					navItems.forEach(item => item.classList.remove('active'));
					
					const menuScreens = ['info-screen-about', 'info-screen-guide', 'info-screen-legal', 'info-screen-settings', 'known-satellites-screen', 'my-satellites-screen', 'latest-starlinks-screen', 'brightest-satellites-screen', 'best-passes-screen', 'menu-screen'];

					if (screenId === 'start-screen') {
						App.elements.navBtnHome.classList.add('active');
					} else if (screenId === 'events-screen') {
                        App.elements.navBtnEvents.classList.add('active');
                    } else if (screenId === 'info-screen-moon') {
						App.elements.navBtnMoon.classList.add('active');
					} else if (menuScreens.includes(screenId)) {
						App.elements.navBtnMenu.classList.add('active');
					}
					// --- FIN: Actualizar estado de la barra de navegación inferior ---
				};

				if (currentVisibleScreen && animate) {
					currentVisibleScreen.classList.add('screen-exit-active');
					currentVisibleScreen.addEventListener('animationend', () => {
						currentVisibleScreen.classList.add('hidden');
						currentVisibleScreen.classList.remove('screen-exit-active');
						cleanupAndShowNext();
					}, { once: true });
				} else {
					cleanupAndShowNext();
				}
			}
		},
		ui: {
			updateButtonsState() {
				const { predictPassesBtn } = App.elements;
				const hasTle = App.state.trackedSatellites.length > 0;
				const hasLocation = App.state.observerCoords !== null;
				predictPassesBtn.disabled = !hasTle || !hasLocation;
			},
			showModal(modalElement) {
				const heavyModals = ['favorites-modal'];
				if (heavyModals.includes(modalElement.id)) {
					const appContainer = App.elements.appContainer;
					if (appContainer && !appContainer.classList.contains('hidden')) {
						appContainer.style.visibility = 'hidden';
					}
				}

				modalElement.classList.remove('hidden');
				setTimeout(() => modalElement.classList.add('is-visible'), 10);
				history.pushState({ modalOpen: true }, '', `#modal`);
			},
			hideModal(modalElement, fromPopState = false) {
				const heavyModals = ['favorites-modal'];
				if (heavyModals.includes(modalElement.id)) {
					const appContainer = App.elements.appContainer;
					if (appContainer) {
						appContainer.style.visibility = 'visible';
					}
				}

				modalElement.classList.remove('is-visible');
				setTimeout(() => modalElement.classList.add('hidden'), 400);
				
				if (modalElement.id === 'social-modal' && !App.elements.startScreen.classList.contains('hidden')) {
					App.elements.hamburgerBtn.classList.remove('hidden');
				}

				if (!fromPopState && location.hash === '#modal') {
					history.back();
				}
			},
			showLoadingModal(textKey = 'calculating', replacements = {}) {
                const { loadingModal, loadingModalText } = App.elements;
                if (!loadingModal) return;
                
                let text = App.language.getTranslation(textKey);
                for (const key in replacements) {
                    text = text.replace(`{${key}}`, replacements[key]);
                }

                loadingModalText.textContent = text;
                loadingModal.classList.remove('hidden');
                setTimeout(() => loadingModal.classList.add('is-visible'), 10);
            },
            hideLoadingModal() {
                const { loadingModal } = App.elements;
                if (!loadingModal) return;
                
                loadingModal.classList.remove('is-visible');
                setTimeout(() => loadingModal.classList.add('hidden'), 400);
            },
			updateLanguageDisplay() {
				const { currentLanguageDisplay } = App.elements;
				if (currentLanguageDisplay) {
					const currentLang = App.settings.current.language;
					currentLanguageDisplay.textContent = App.language.getTranslation(`langButton${currentLang.charAt(0).toUpperCase() + currentLang.slice(1)}`);
				}
			},
			updatePageIndicator(isCompassPageActive) {
                const { pageIndicatorDots } = App.elements;
                if (!pageIndicatorDots || !pageIndicatorDots.dots) return;

                const dots = pageIndicatorDots.dots;
                if (isCompassPageActive) {
                    dots[0].classList.remove('active-dot');
                    dots[1].classList.add('active-dot');
                } else {
                    dots[0].classList.add('active-dot');
                    dots[1].classList.remove('active-dot');
                }
            },
			updatePageIndicator(isCompassPageActive) {
                const { pageIndicatorDots } = App.elements;
                if (!pageIndicatorDots || !pageIndicatorDots.dots) return;

                const dots = pageIndicatorDots.dots;
                if (isCompassPageActive) {
                    dots[0].classList.remove('active-dot');
                    dots[1].classList.add('active-dot');
                } else {
                    dots[0].classList.add('active-dot');
                    dots[1].classList.remove('active-dot');
                }
            },
			showToast(message, type = 'success', duration = 4000) {
				const container = document.getElementById('toast-container');
				if (!container) return;
		
				const toast = document.createElement('div');
				toast.className = `toast-message ${type}`;
				
				const icon = document.createElement('i');
				icon.className = `fa-solid ${type === 'success' ? 'fa-check-circle' : 'fa-times-circle'}`;
				
				const text = document.createElement('span');
				text.textContent = message;
		
				toast.appendChild(icon);
				toast.appendChild(text);
		
				container.appendChild(toast);
		
				setTimeout(() => {
					toast.remove();
				}, duration);
			},

            showDailyUpdateModal(show) {
                const { dailyUpdateModal, startScreen } = App.elements;

                if (show) {
                    dailyUpdateModal.classList.remove('hidden');
                    setTimeout(() => {
                        dailyUpdateModal.classList.add('is-visible');
                        startScreen.classList.add('modal-open');
                    }, 10);
                } else {
                    dailyUpdateModal.classList.remove('is-visible');
                    startScreen.classList.remove('modal-open');
                    setTimeout(() => {
                        dailyUpdateModal.classList.add('hidden');
                    }, 400);
                }
            },

            async showDailyUpdate() {
                const { dailyUpdatePill, dailyUpdateModalContent, dailyUpdateTextPill, dailyUpdateIcon } = App.elements;
                const shadowElement = document.getElementById('moon-phase-shadow');
            
                if (App.state.dailyUpdateCarouselInterval) {
                    clearInterval(App.state.dailyUpdateCarouselInterval);
                }

                if (!dailyUpdatePill || !shadowElement || !dailyUpdateModalContent || !dailyUpdateTextPill) {
                    if (dailyUpdatePill) dailyUpdatePill.classList.add('hidden');
                    return;
                }
            
                const getMoonPhaseName = (phase) => {
                    const langKeyPrefix = 'moonPhase';
                    if (phase < 0.03 || phase > 0.97) return App.language.getTranslation(langKeyPrefix + 'New');
                    if (phase < 0.22) return App.language.getTranslation(langKeyPrefix + 'WaxingCrescent');
                    if (phase < 0.28) return App.language.getTranslation(langKeyPrefix + 'FirstQuarter');
                    if (phase < 0.47) return App.language.getTranslation(langKeyPrefix + 'WaxingGibbous');
                    if (phase < 0.53) return App.language.getTranslation(langKeyPrefix + 'Full');
                    if (phase < 0.72) return App.language.getTranslation(langKeyPrefix + 'WaningGibbous');
                    if (phase < 0.78) return App.language.getTranslation(langKeyPrefix + 'LastQuarter');
                    return App.language.getTranslation(langKeyPrefix + 'WaningCrescent');
                };
            
                const now = new Date();
                const moonInfo = SunCalc.getMoonIllumination(now);
                const phase = moonInfo.phase;
                const phaseName = getMoonPhaseName(phase);
                const illuminationPercent = (moonInfo.fraction * 100).toFixed(0);

                const isSouthernHemisphere = App.state.observerCoords ? App.state.observerCoords[0] < 0 : false;
                let translationPercent;
                if (phase <= 0.5) {
                    const progress = phase / 0.5;
                    translationPercent = isSouthernHemisphere ? progress * 100 : progress * -100;
                } else {
                    const progress = (phase - 0.5) / 0.5;
                    translationPercent = isSouthernHemisphere ? -100 + (progress * 100) : 100 - (progress * 100);
                }
            
                const carouselItems = [
                    {
                        type: 'moon',
                        text: `Luna al ${illuminationPercent}%`,
                        iconHtml: `<div id="moon-phase-shadow" style="transform: translateX(${translationPercent}%);"></div>`
                    }
                ];
                let upcomingPasses = [];

                if (App.state.observerCoords) {
                    const satsToCheck = [
                        ...Object.values(App.config.knownSatellites),
                        ...App.config.latestStarlinks
                    ];
            
                    const todayEnd = new Date();
                    todayEnd.setHours(23, 59, 59, 999);
            
                    for (const sat of satsToCheck) {
                        if (!sat || !sat.tle) continue;
            
                        const parsed = App.satellites.parseTLE(sat.tle);
                        if (parsed.length === 0) continue;
            
                        try {
                            const satrec = satellite.twoline2satrec(parsed[0].line1, parsed[0].line2);
                            const satDataForCalc = { name: sat.name, satrec: satrec };
                            
                            const passes = App.prediction.calculateVisiblePasses(satDataForCalc, App.state.observerCoords, { days: 1 });
            
                            for (const pass of passes) {
                                if (pass.end < now || pass.start > todayEnd) continue;
            
                                const isHubble = sat.noradId === 20580;
                                const elevationThreshold = isHubble ? 25 : 30;
            
                                if (pass.maxElevation > elevationThreshold) {
                                    upcomingPasses.push({ ...pass, satName: sat.name, tle: sat.tle });
                                }
                            }
                        } catch (e) { /* Ignorar TLEs inválidos */ }
                    }
            
                    upcomingPasses.sort((a, b) => a.start - b.start);

                    dailyUpdatePill.classList.toggle('has-special-event', upcomingPasses.length > 0);
            
                    upcomingPasses.forEach(pass => {
                        let satNameForPill = pass.satName;
                        const lowerCaseName = satNameForPill.toLowerCase();

                        if (lowerCaseName.includes('iss')) {
                            satNameForPill = 'ISS';
                        } else if (lowerCaseName.includes('tiangong')) {
                            satNameForPill = 'Tiangong';
                        } else if (lowerCaseName.includes('starlink')) {
                            satNameForPill = 'Starlink';
                        } else if (lowerCaseName.includes('hubble')) {
                            satNameForPill = 'Hubble';
                        } else {
                            satNameForPill = satNameForPill.split(' (')[0].trim();
                        }

                        carouselItems.push({
                            type: 'satellite',
                            text: `${satNameForPill} ${App.time.formatCityTime(pass.start, { hour: '2-digit', minute: '2-digit' })}`,
                            iconHtml: `<i class="fa-solid fa-satellite" style="font-size: 14px;"></i>`
                        });
                    });
                }

                let currentItemIndex = 0;
                function updatePillContent() {
                    const item = carouselItems[currentItemIndex];
                    dailyUpdateTextPill.textContent = item.text;
                    dailyUpdateIcon.innerHTML = item.iconHtml;

                    if (item.type === 'moon') {
                        dailyUpdateIcon.style.backgroundColor = '#f0f0f0';
                        dailyUpdateIcon.style.display = 'block';
                        dailyUpdateIcon.style.color = 'inherit';
                    } else if (item.type === 'satellite') {
                        dailyUpdateIcon.style.backgroundColor = 'transparent';
                        dailyUpdateIcon.style.display = 'flex';
                        dailyUpdateIcon.style.alignItems = 'center';
                        dailyUpdateIcon.style.justifyContent = 'center';
                        dailyUpdateIcon.style.color = 'var(--color-secondary)';
                    }
                    currentItemIndex = (currentItemIndex + 1) % carouselItems.length;
                }
                
                if (carouselItems.length > 0) {
                    updatePillContent();
                    App.state.dailyUpdateCarouselInterval = setInterval(updatePillContent, 3000);
                }

                dailyUpdateModalContent.innerHTML = '';
                
                const card = document.createElement('div');
                card.className = 'daily-update-card';
                card.id = 'daily-update-moon-card';
                card.addEventListener('click', () => {
                    this.showDailyUpdateModal(false); 
                    setTimeout(() => {
                        App.playSound('uiClick', 'F4');
                        App.navigation.go('info-screen-moon');
                    }, 150);
                });

                const cardMain = document.createElement('div');
                cardMain.className = 'daily-update-card-main';
                const iconClone = dailyUpdateIcon.cloneNode(true);
                const shadowInClone = iconClone.querySelector('#moon-phase-shadow');
                if (shadowInClone) shadowInClone.style.setProperty('transform', `translateX(${translationPercent}%)`);
                cardMain.innerHTML = `<span>${phaseName}</span>`;
                cardMain.prepend(iconClone);

                const cardDetails = document.createElement('div');
                cardDetails.className = 'daily-update-card-details';

                let riseTime = '--:--'; let setTime = '--:--';
                const illumination = (moonInfo.fraction * 100).toFixed(0);

                if (App.state.observerCoords) {
                    const [lat, lon] = App.state.observerCoords;
                    const moonTimes = SunCalc.getMoonTimes(now, lat, lon);
                    const timeOptions = { hour: '2-digit', minute: '2-digit' };
                    if(moonTimes.rise) riseTime = App.time.formatCityTime(moonTimes.rise, timeOptions);
                    if(moonTimes.set) setTime = App.time.formatCityTime(moonTimes.set, timeOptions);
                }
            
                cardDetails.innerHTML = `
                    <div class="detail-item">
                        <i class="fa-solid fa-arrow-up"></i>
                        <span class="detail-value">${riseTime}</span>
                        <span class="detail-label" data-lang-key="moonRise">Sale</span>
                    </div>
                    <div class="detail-item">
                        <i class="fa-solid fa-arrow-down"></i>
                        <span class="detail-value">${setTime}</span>
                        <span class="detail-label" data-lang-key="moonSet">Pone</span>
                    </div>
                    <div class="detail-item">
                        <i class="fa-solid fa-circle-half-stroke"></i>
                        <span class="detail-value">${illumination}%</span>
                        <span class="detail-label">Fase</span>
                    </div>
                `;

                card.appendChild(cardMain);
                card.appendChild(cardDetails);
                dailyUpdateModalContent.appendChild(card);
                
                if (upcomingPasses.length > 0) {
                    upcomingPasses.forEach((pass, index) => {
                        const passCard = document.createElement('div');
                        passCard.className = 'daily-update-card';
                        passCard.style.animationDelay = `${(index + 1) * 100}ms`;
                        passCard.style.cursor = 'pointer';

                        const lowerCaseName = pass.satName.toLowerCase();
                        if (lowerCaseName.includes('iss') || lowerCaseName.includes('tiangong') || lowerCaseName.includes('hubble')) {
                            passCard.classList.add('pass-card-popular');
                        } else if (lowerCaseName.includes('starlink')) {
                            passCard.classList.add('pass-card-starlink-event');
                        }
                        
                        passCard.addEventListener('click', () => {
                            this.showDailyUpdateModal(false);
                            setTimeout(() => {
                                App.playSound('success', 'A4');
                                App.state.pendingPassJumpTimestamp = pass.start.getTime();
                                localStorage.setItem(App.config.lastSatStorageKey, pass.tle);
                                App.elements.tleInput.value = pass.tle;
                                App.satellites.handleTleLoad(true);
                                App.navigation.go('app-container');
                            }, 150);
                        });

                        const passCardMain = document.createElement('div');
                        passCardMain.className = 'daily-update-card-main';
                        passCardMain.innerHTML = `<span>Paso visible: ${pass.satName}</span>`;

                        const passCardDetails = document.createElement('div');
                        passCardDetails.className = 'daily-update-card-details';
                        
                        const timeOptions = { hour: '2-digit', minute: '2-digit' };
                        const startDir = App.prediction.getCardinalDirection(satellite.radiansToDegrees(pass.startAz || 0));
                        const endDir = App.prediction.getCardinalDirection(satellite.radiansToDegrees(pass.endAz || 0));
                        
                        passCardDetails.innerHTML = `
                            <div class="detail-item">
                                <span class="detail-value">${App.time.formatCityTime(pass.start, timeOptions)}<br>${App.time.formatCityTime(pass.end, timeOptions)}</span>
                                <span class="detail-label">Hora</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-value">${pass.maxElevation.toFixed(0)}°</span>
                                <span class="detail-label">Elev. Máx.</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-value">${startDir} → ${endDir}</span>
                                <span class="detail-label">Dirección</span>
                            </div>
                        `;

                        passCard.appendChild(passCardMain);
                        passCard.appendChild(passCardDetails);
                        dailyUpdateModalContent.appendChild(passCard);
                    });
                }
            
                dailyUpdatePill.classList.remove('hidden');
            },
			
		},
		mapLayers: {
			init() { const { mapStyleToggleBtn, mapStyleOptions } = App.elements; mapStyleToggleBtn.addEventListener('click', () => { App.playSound('uiClick', 'D4'); App.elements.mapStyleSwitcher.classList.toggle('is-open'); }); mapStyleOptions.addEventListener('click', (e) => { const button = e.target.closest('.map-style-btn'); if (button) { const layerId = button.dataset.layer; this.switchLayer(layerId); App.playSound('uiClick', 'C4'); App.elements.mapStyleSwitcher.classList.remove('is-open'); } }); },
			defineLayers() {
				const maptilerApiKey = 'T0Hykq7m9NBM9wLS2eIw';
				const maptilerAttribution = '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';
                const lang = App.settings.current.language;

				App.state.baseLayers = {
					dark: L.tileLayer(`https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}@2x.png?key=${maptilerApiKey}&language=${lang}`, {
						attribution: maptilerAttribution,
						maxZoom: 20,
						tileSize: 512,
						zoomOffset: -1
					}),
					satellite: L.tileLayer(`https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}@2x.jpg?key=${maptilerApiKey}&language=${lang}`, {
						attribution: maptilerAttribution,
						maxZoom: 19,
						tileSize: 512,
						zoomOffset: -1
					}),
				};
			},
			switchLayer(layerId) {
				if (!App.state.map || !App.state.baseLayers[layerId]) return;
				if (App.state.currentBaseLayer) {
					App.state.map.removeLayer(App.state.currentBaseLayer);
				}
				App.state.currentBaseLayer = App.state.baseLayers[layerId];
				App.state.map.addLayer(App.state.currentBaseLayer);
				const tilePane = App.state.map.getPane('tilePane');
				const appContainer = App.elements.appContainer;
				
				if (layerId === 'satellite') {
					tilePane.classList.remove('dark-map');
					tilePane.classList.add('satellite-map');
					appContainer.classList.add('satellite-view-active');
				} else {
					tilePane.classList.remove('satellite-map');
					tilePane.classList.add('dark-map');
					appContainer.classList.remove('satellite-view-active');
				}
				
				App.elements.mapStyleOptions.querySelectorAll('.map-style-btn').forEach(btn => {
					btn.classList.toggle('active', btn.dataset.layer === layerId);
				});
			}
		},
		mySatellites: {
			showScreen() { App.navigation.go('my-satellites-screen'); },
			renderWithAnimation(container, items, renderFn) {
				container.innerHTML = '';
				items.forEach((item, index) => {
					const element = renderFn(item, index);
					container.appendChild(element);
				});
			},
			renderKnownSatellitesList() {
				const container = App.elements.knownSatellitesList;
				container.innerHTML = '';
				const satList = Object.entries(App.config.knownSatellites);
				this.renderWithAnimation(container, satList, ([id, sat]) => {
					const satElement = document.createElement('div');
					satElement.className = 'satellite-entry'; 
					satElement.dataset.satId = id;
					satElement.id = `known-sat-${id}`;
					satElement.innerHTML = `
                        <div class="satellite-entry-clickable known-satellite-btn">
                            <div class="satellite-entry-info">
                                <h3 class="satellite-entry-name">${sat.name}</h3>
                                <p class="satellite-entry-desc">${sat.description}</p>
                            </div>
                        </div>
						<div class="satellite-entry-actions">
							<div class="sat-status-indicator">
								<i class="fa-solid fa-spinner fa-spin"></i>
							</div>
							<button class="favorite-btn" data-sat-id="${id}" data-lang-key="favoriteButton" title="Guardar en Mis Satélites">
								<i class="fa-regular fa-heart"></i>
							</button>
						</div>`;
					return satElement;
				});

				this.updateFavoriteIcons();
			},
			renderBrightestSatellites() {
				const container = App.elements.brightestSatellitesList;
				container.innerHTML = '';
				const brightest = App.config.brightestSatellites;
				if (brightest.length === 0) {
					container.innerHTML = `<div class="text-center p-8"><i class="fa-solid fa-spinner fa-spin text-3xl"></i><p class="mt-4" data-lang-key="calculating">${App.language.getTranslation('calculating')}</p></div>`;
					return;
				}
				this.renderWithAnimation(container, brightest, (sat) => {
					const tleId = getTleId(sat.tle);
					const satElement = document.createElement('div');
					satElement.className = 'satellite-entry';
					satElement.dataset.name = sat.name;
					satElement.dataset.tle = sat.tle;
					satElement.id = `bright-sat-${tleId}`;
			
					satElement.innerHTML = `
						<div class="satellite-entry-clickable known-satellite-btn">
							<div class="satellite-entry-info">
								<h3 class="satellite-entry-name">${sat.name}</h3>
							</div>
						</div>
						<div class="satellite-entry-actions">
							<button class="favorite-btn" data-name="${sat.name}" data-tle='${sat.tle}' data-lang-key="favoriteButton" title="Guardar en Mis Satélites">
								<i class="fa-regular fa-heart"></i>
							</button>
						</div>`;
					return satElement;
				});
				this.updateFavoriteIcons();
			},
			renderFavoriteSatellitesOnKnownScreen() {
				const container = App.elements.favoriteSatellitesListKnownScreen;
				const noFavoritesMsg = App.elements.noFavoritesOnKnownScreenMsg;
				const mySats = this.loadFromStorage();
				const popularSatNames = Object.values(App.config.knownSatellites).map(sat => sat.name);
				const filteredSats = mySats.filter(sat => !popularSatNames.includes(sat.name));
				
				container.innerHTML = '';
		
				if (filteredSats.length === 0) {
					container.classList.add('hidden');
					noFavoritesMsg.textContent = App.language.getTranslation('noCustomFavorites');
					noFavoritesMsg.classList.remove('hidden');
					return;
				}
				
				noFavoritesMsg.classList.add('hidden');
				container.classList.remove('hidden');
		
				this.renderWithAnimation(container, filteredSats, (sat) => {
					const tleId = getTleId(sat.tle);
					const satElement = document.createElement('div');
					satElement.className = 'satellite-entry';
					satElement.dataset.name = sat.name;
					satElement.dataset.tle = sat.tle;
					satElement.id = `fav-ks-${tleId.replace(/\s/g, '')}`;
			
					satElement.innerHTML = `
						<div class="satellite-entry-clickable known-satellite-btn">
							<div class="satellite-entry-info">
								<h3 class="satellite-entry-name">${sat.name}</h3>
							</div>
						</div>
						<div class="satellite-entry-actions">
							<button class="favorite-btn is-favorite" data-name="${sat.name}" data-tle='${sat.tle}' data-lang-key="favoriteButton" title="Quitar de Mis Satélites">
								<i class="fa-solid fa-heart"></i>
							</button>
						</div>`;
					
					satElement.querySelector('.satellite-entry-clickable').addEventListener('click', () => {
						this.handleTrack(sat.tle);
					});

					satElement.querySelector('.favorite-btn').addEventListener('click', (e) => {
						e.stopPropagation();
						this.handleFavoriteClick(sat.name, sat.tle);
						this.renderFavoriteSatellitesOnKnownScreen(); 
					});

					return satElement;
				});
			},
			updateFavoriteIcons() {
				const mySats = this.loadFromStorage();
				const favoriteSatNames = mySats.map(s => s.name);
				
				document.querySelectorAll('#known-satellites-list .satellite-entry, #brightest-satellites-list .satellite-entry').forEach(satElement => {
					const btn = satElement.querySelector('.favorite-btn');
					if (!btn) return;

					let satName = satElement.dataset.name;
					if (!satName) {
						const satId = satElement.dataset.satId;
						if (satId && App.config.knownSatellites[satId]) {
							satName = App.config.knownSatellites[satId].name;
						}
					}
			
					const heartIcon = btn.querySelector('i');
					const isFav = satName ? favoriteSatNames.includes(satName) : false;
			
					btn.classList.toggle('is-favorite', isFav);
					heartIcon.classList.toggle('fa-regular', !isFav);
					heartIcon.classList.toggle('fa-solid', isFav);
				});
			},
			handleFavoriteClick(name, tle) {
				if (!name || !tle) { App.playSound('error', 'C3'); return; }
				let mySats = this.loadFromStorage();
				const existingIndex = mySats.findIndex(s => s.name === name);
			
				if (existingIndex > -1) {
					mySats.splice(existingIndex, 1);
					App.playSound('trash');
				} else {
					mySats.push({ name: name, tle: tle });
					App.playSound('success', 'A4');
				}
			
				this.saveToStorage(mySats);
				this.updateFavoriteIcons();
				App.ui.updateButtonsState();
			},
			renderFavoritesForSelection() {
				const container = App.elements.favoritesModalList;
				container.innerHTML = '';
			
				const favsHeader = document.createElement('h3');
				favsHeader.className = 'pass-date-header';
				favsHeader.dataset.langKey = 'favoriteSatellites';
				favsHeader.textContent = App.language.getTranslation('favoriteSatellites');
				favsHeader.style.paddingTop = '0';
				const favsContainer = document.createElement('div');
				favsContainer.id = 'favorites-list-container';
				favsContainer.className = 'space-y-3';
			
				const allHeader = document.createElement('h3');
				allHeader.className = 'pass-date-header';
				allHeader.dataset.langKey = 'allSatellites';
				allHeader.textContent = App.language.getTranslation('allSatellites');
				const allContainer = document.createElement('div');
				allContainer.id = 'all-satellites-list-container';
				allContainer.className = 'space-y-3';
			
				const mySats = this.loadFromStorage();
				const knownSats = Object.values(App.config.knownSatellites).filter(s => s.tle);
				const starlinks = App.config.latestStarlinks;
                const brightest = App.config.brightestSatellites;
				const favoriteTleIds = mySats.map(sat => getTleId(sat.tle));
			
				let currentlyTrackedTles = App.state.trackedSatellites.map(sat => sat.tle);
				
				const currentlyTrackedIds = currentlyTrackedTles.map(getTleId);
				const isMultiTracking = currentlyTrackedTles.length > 1;
			
				App.state.selectedTlesForMulti = isMultiTracking ? [...currentlyTrackedTles] : [];
				
				const animateFavoriteTransition = (cardElement, targetContainer) => {
					const startPos = cardElement.getBoundingClientRect();
					
					targetContainer.appendChild(cardElement);
					
					const endPos = cardElement.getBoundingClientRect();
			
					const deltaX = startPos.left - endPos.left;
					const deltaY = startPos.top - endPos.top;
			
					cardElement.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
					cardElement.classList.add('moving-favorite');
			
					requestAnimationFrame(() => {
						cardElement.style.transform = '';
					});
			
					cardElement.addEventListener('transitionend', () => {
						cardElement.classList.remove('moving-favorite');
						cardElement.style.transform = '';
					}, { once: true });
				};
			
				const handleFavoriteToggle = (e) => {
					e.stopPropagation();
					const button = e.currentTarget;
					const card = button.closest('.modal-satellite-card');
					const tle = card.dataset.tle;
					const satName = card.dataset.name;
			
					App.playSound('uiClick', 'D4');
			
					let mySats = this.loadFromStorage();
					const existingIndex = mySats.findIndex(s => getTleId(s.tle) === getTleId(tle));
					
					const isBecomingFavorite = existingIndex === -1;
					
					if (isBecomingFavorite) {
						mySats.push({ name: satName, tle: tle });
						button.classList.add('is-favorite');
						button.querySelector('i').classList.replace('fa-regular', 'fa-solid');
						animateFavoriteTransition(card, favsContainer);
					} else {
						mySats.splice(existingIndex, 1);
						button.classList.remove('is-favorite');
						button.querySelector('i').classList.replace('fa-solid', 'fa-regular');
						animateFavoriteTransition(card, allContainer);
					}
					
					this.saveToStorage(mySats);
					this.updateFavoriteIcons();
				};
			
				const createSatelliteButton = (sat, isFavorite) => {
					const satButton = document.createElement('div');
					satButton.className = 'modal-satellite-card';
					satButton.dataset.tle = sat.tle;
					satButton.dataset.name = sat.name;
			
					satButton.innerHTML = `
						<div class="flex-grow">
							<span class="font-bold block text-base"><i class="fa-solid fa-satellite-dish mr-3 text-secondary"></i>${sat.name}</span>
						</div>
						<button class="favorite-toggle-btn ${isFavorite ? 'is-favorite' : ''}" data-lang-key="favoriteButton" title="Marcar como Favorito">
							<i class="fa-${isFavorite ? 'solid' : 'regular'} fa-heart text-xl"></i>
						</button>`;
			
					const satId = getTleId(sat.tle);
					if (isMultiTracking && currentlyTrackedIds.includes(satId)) {
						satButton.classList.add('is-selected');
					}
			
					satButton.addEventListener('click', (e) => {
						if (e.target.closest('.favorite-toggle-btn')) return;
						const tle = e.currentTarget.dataset.tle;
						if (App.state.isMultiSelectMode) {
							e.currentTarget.classList.toggle('is-selected');
							const isSelectedNow = e.currentTarget.classList.contains('is-selected');
							const alreadyExists = App.state.selectedTlesForMulti.some(existingTle => getTleId(existingTle) === getTleId(tle));
							if (isSelectedNow && !alreadyExists) App.state.selectedTlesForMulti.push(tle);
							else App.state.selectedTlesForMulti = App.state.selectedTlesForMulti.filter(existingTle => getTleId(existingTle) !== getTleId(tle));
							this.updateMultiSelectUI();
						} else {
							this.handleTrack(tle);
							history.back();
							App.elements.mainControlPanel.classList.remove('expanded');
						}
					});
			
					satButton.querySelector('.favorite-toggle-btn').addEventListener('click', handleFavoriteToggle);
			
					return satButton;
				};
			
				const allAvailableSats = new Map();
				[...knownSats, ...starlinks, ...brightest, ...mySats].forEach(s => {
					if (s.tle) {
					   allAvailableSats.set(getTleId(s.tle), s);
					}
				});
			
				allAvailableSats.forEach(sat => {
					const isFav = favoriteTleIds.includes(getTleId(sat.tle));
					const button = createSatelliteButton(sat, isFav);
					if(isFav) {
						favsContainer.appendChild(button);
					} else {
						allContainer.appendChild(button);
					}
				});
				
				container.appendChild(favsHeader);
				container.appendChild(favsContainer);
				
				allHeader.style.paddingTop = '0.75rem';
				container.appendChild(allHeader);
				container.appendChild(allContainer);
			
				if (allAvailableSats.size === 0) {
					container.innerHTML = `<p class="text-text-secondary text-center p-4" data-lang-key="noSatsLoaded">${App.language.getTranslation('noSatsLoaded')}</p>`
				}
			
				this.toggleMultiSelectMode(isMultiTracking ? true : false);
			},
			toggleMultiSelectMode(forceState = null) {
				const { favoritesModal, toggleMultiSelectBtn, favoritesModalFooter } = App.elements;
				
				const wasMultiSelect = App.state.isMultiSelectMode;
				App.state.isMultiSelectMode = forceState !== null ? forceState : !App.state.isMultiSelectMode;
				
				favoritesModal.classList.toggle('multi-select-active', App.state.isMultiSelectMode);
				toggleMultiSelectBtn.classList.toggle('active', App.state.isMultiSelectMode);

                favoritesModalFooter.classList.toggle('controls-visible', App.state.isMultiSelectMode);

				if (App.state.isMultiSelectMode) {
					App.playSound('uiClick', 'E4');
					if (!wasMultiSelect && forceState !== true) {
						App.state.selectedTlesForMulti = [];
						favoritesModal.querySelectorAll('.modal-satellite-card.is-selected').forEach(card => card.classList.remove('is-selected'));
					}
				} else {
					App.playSound('uiClick', 'A3');
					App.state.selectedTlesForMulti = [];
					favoritesModal.querySelectorAll('.modal-satellite-card.is-selected').forEach(card => card.classList.remove('is-selected'));
				}
				this.updateMultiSelectUI();
			},
			updateMultiSelectUI() {
				const { multiSelectCounter, showSelectedSatsBtn } = App.elements;
				const count = App.state.selectedTlesForMulti.length;
				
				const key = count === 1 ? 'multiSelectCounterSingular' : 'multiSelectCounterPlural';
				multiSelectCounter.textContent = App.language.getTranslation(key).replace('{count}', count);

				showSelectedSatsBtn.disabled = count === 0;
			},
			trackMultipleSelected() {
				if (App.state.selectedTlesForMulti.length === 0) return;
				App.playSound('success', 'A4');

                const combinedTles = App.state.selectedTlesForMulti.join('\n');
				localStorage.setItem(App.config.lastSatStorageKey, combinedTles);
				App.elements.tleInput.value = combinedTles;
				App.satellites.handleTleLoad(true, true);

				if (!App.elements.appContainer.classList.contains('hidden')) {
					App.satellites.handleTracking();
				} else {
					App.navigation.go('app-container');
				}
				history.back();
			},
			
			renderList() {
				const { mySatellitesList, noMySatellitesMsg } = App.elements;
				const customSats = this.loadFromStorage(App.config.customTleStorageKey);
				const allFavs = this.loadFromStorage();
				const allFavTleIds = allFavs.map(fav => getTleId(fav.tle));
			
				mySatellitesList.innerHTML = '';
				noMySatellitesMsg.classList.toggle('hidden', customSats.length > 0);
				mySatellitesList.classList.toggle('hidden', customSats.length === 0);
			
				this.renderWithAnimation(mySatellitesList, customSats, (sat, index) => {
					const satElement = document.createElement('div');
					satElement.className = 'satellite-entry';
					const isFavorite = allFavTleIds.includes(getTleId(sat.tle));

					satElement.innerHTML = `
						<div class="satellite-entry-clickable" data-tle="${sat.tle}">
							<div class="satellite-entry-info">
								<h3 class="satellite-entry-name">${sat.name}</h3>
							</div>
						</div>
						<div class="satellite-entry-actions">
							<button class="favorite-btn ${isFavorite ? 'is-favorite' : ''}" data-name="${sat.name}" data-tle='${sat.tle}' data-lang-key="favoriteButton" title="Añadir/Quitar de Favoritos">
								<i class="fa-${isFavorite ? 'solid' : 'regular'} fa-heart"></i>
							</button>
							<button class="delete-sat-btn h-9 w-9 flex items-center justify-center rounded-full text-red-400 hover:bg-red-500/20 transition-colors" data-name="${sat.name}" data-lang-key="deleteButton" title="Eliminar">
								<i class="fa-solid fa-trash-can"></i>
							</button>
						</div>`;
					satElement.querySelector('.satellite-entry-clickable').addEventListener('click', (e) => this.handleTrack(e.currentTarget.dataset.tle));
					satElement.querySelector('.delete-sat-btn').addEventListener('click', (e) => { e.stopPropagation(); this.handleDelete(e.currentTarget.dataset.name); });
					
					satElement.querySelector('.favorite-btn').addEventListener('click', (e) => {
						e.stopPropagation();
						const btn = e.currentTarget;
						const heartIcon = btn.querySelector('i');
						this.handleFavoriteClick(btn.dataset.name, btn.dataset.tle);
						
						const isNowFavorite = !btn.classList.contains('is-favorite');
						btn.classList.toggle('is-favorite', isNowFavorite);
						heartIcon.classList.toggle('fa-regular', !isNowFavorite);
						heartIcon.classList.toggle('fa-solid', isNowFavorite);
					});
					
					return satElement;
				});
			},
			handleSaveTle() {
				const { tleInput } = App.elements, tleData = tleInput.value.trim(), parsedSats = App.satellites.parseTLE(tleData);
				if(parsedSats.length === 0 || !parsedSats[0].name){ App.playSound('error', 'C3'); return; }
				const newSat = { name: parsedSats[0].name, tle: `${parsedSats[0].name}\n${parsedSats[0].line1}\n${parsedSats[0].line2}` };
				const customSats = this.loadFromStorage(App.config.customTleStorageKey); customSats.push(newSat); this.saveToStorage(customSats, App.config.customTleStorageKey);
				App.playSound('success', 'G5'); history.back(); this.renderList(); App.ui.updateButtonsState();
			},
			handleDelete(name) {
				const customSats = this.loadFromStorage(App.config.customTleStorageKey), satToDelete = customSats.find(s => s.name === name); if (!satToDelete) return;
				App.elements.confirmModalText.textContent = App.language.getTranslation('confirmDeleteDesc').replace('{name}', satToDelete.name); 
				App.elements.confirmDeleteBtn.dataset.name = name; 
				App.ui.showModal(App.elements.confirmModal);
			},
			confirmDelete(event) { const name = event.currentTarget.dataset.name; if (!name) return; App.playSound('trash'); let customSats = this.loadFromStorage(App.config.customTleStorageKey); const indexToDelete = customSats.findIndex(s => s.name === name); if(indexToDelete > -1) { customSats.splice(indexToDelete, 1); } this.saveToStorage(customSats, App.config.customTleStorageKey); this.renderList(); history.back(); App.ui.updateButtonsState(); },
			handleTrack(tleString, isAutoLoad = false) {
				// Lógica simplificada, similar a la función loadKnown que sí funciona.
				if (!tleString) {
					App.playSound('error', 'D3');
					console.error("handleTrack recibió un TLE inválido.");
					return;
				}

				if (!isAutoLoad) App.playSound('success', 'G4');
				
				try { 
					localStorage.setItem(App.config.lastSatStorageKey, tleString); 
				} catch(e) { 
					console.error("Error guardando último satélite:", e); 
				}

				App.elements.tleInput.value = tleString;
				App.satellites.handleTleLoad(true); 
				App.navigation.go('app-container');
			},
			loadFromStorage(key = App.config.localStorageKey) {
				try {
					const data = localStorage.getItem(key);
					if (!data) return [];
					
					let satellites = JSON.parse(data);

					// Esta parte revisa los satélites guardados para asegurar que el TLE siempre incluya el nombre.
					// Soluciona problemas si datos de una versión anterior fueron guardados en un formato viejo (TLE de 2 líneas).
					let needsUpdate = false;
					satellites.forEach(sat => {
						if (sat.name && sat.tle && !sat.tle.trim().startsWith(sat.name)) {
							const lines = sat.tle.trim().split('\n');
							const line1 = lines.find(l => l.trim().startsWith('1 '));
							const line2 = lines.find(l => l.trim().startsWith('2 '));

							if (line1 && line2) {
								sat.tle = `${sat.name}\n${line1}\n${line2}`;
								needsUpdate = true;
							}
						}
					});

					// Si se corrigió algún dato, se vuelve a guardar en el formato correcto para futuras cargas.
					if (needsUpdate) {
						this.saveToStorage(satellites, key);
					}

					return satellites;
				} catch (e) {
					console.error(`Error al cargar desde localStorage (${key}):`, e);
					return [];
				}
			},
			saveToStorage(satellites, key = App.config.localStorageKey) { try { localStorage.setItem(key, JSON.stringify(satellites)); } catch (e) { console.error(e); } }
		},
		starlinks: {
			async showScreen() {
				const { latestStarlinksContent } = App.elements;
				latestStarlinksContent.innerHTML = `<div class="text-center p-8"><i class="fa-solid fa-spinner fa-spin text-3xl"></i><p class="mt-4" data-lang-key="calculating">${App.language.getTranslation('calculating')}</p></div>`;
		
				const starlinkSats = App.config.latestStarlinks;
		
				if (!starlinkSats || starlinkSats.length === 0) {
					latestStarlinksContent.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg">No hay nuevos satélites Starlink para mostrar.</p>`;
					return;
				}
		
				const fragment = document.createDocumentFragment();
		
				const satsHeader = document.createElement('h3');
				satsHeader.className = 'list-title';
				satsHeader.textContent = App.language.getTranslation('satellitesTitle');
				fragment.appendChild(satsHeader);
		
				const satListContainer = document.createElement('div');
				satListContainer.className = 'space-y-2 mb-8';
				starlinkSats.forEach(sat => {
					const satElement = document.createElement('div');
					satElement.className = 'satellite-entry';
					satElement.innerHTML = `
						<div class="satellite-entry-clickable" data-tle='${sat.tle}'>
							<div class="satellite-entry-info">
								<h3 class="satellite-entry-name">${sat.name}</h3>
							</div>
						</div>
						<div class="satellite-entry-actions">
							<button class="favorite-btn" data-name="${sat.name}" data-tle='${sat.tle}' title="Guardar en Mis Satélites">
								<i class="fa-regular fa-heart"></i>
							</button>
						</div>
					`;
					satElement.querySelector('.satellite-entry-clickable').addEventListener('click', (e) => {
						App.mySatellites.handleTrack(e.currentTarget.dataset.tle);
					});
					satElement.querySelector('.favorite-btn').addEventListener('click', (e) => {
						const btn = e.currentTarget;
						App.mySatellites.handleFavoriteClick(sat.name, sat.tle);
						btn.classList.toggle('is-favorite');
						const heartIcon = btn.querySelector('i');
						const isFav = btn.classList.contains('is-favorite');
						heartIcon.classList.toggle('fa-regular', !isFav);
						heartIcon.classList.toggle('fa-solid', isFav);
					});
					satListContainer.appendChild(satElement);
				});
				fragment.appendChild(satListContainer);
		
				const passesHeader = document.createElement('h3');
				passesHeader.className = 'list-title';
				passesHeader.textContent = App.language.getTranslation('visiblePassesButton');
				fragment.appendChild(passesHeader);
		
				const passesContainer = document.createElement('div');
				passesContainer.className = 'space-y-3 pb-4';
				fragment.appendChild(passesContainer);
		
				latestStarlinksContent.innerHTML = '';
				latestStarlinksContent.appendChild(fragment);
				App.mySatellites.updateFavoriteIcons();
		
				if (!App.state.observerCoords) {
					passesContainer.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg" data-lang-key="setLocationForBestPasses">${App.language.getTranslation('setLocationForBestPasses')}</p>`;
					return;
				}
		
				let allPasses = [];
				const satrecs = starlinkSats.map(sat => {
					const parsed = App.satellites.parseTLE(sat.tle);
					if (!parsed[0]) return null;
					try {
						return { name: sat.name, satrec: satellite.twoline2satrec(parsed[0].line1, parsed[0].line2), tle: sat.tle };
					} catch (e) {
						return null;
					}
				}).filter(Boolean);
		
				for (const sat of satrecs) {
					const passes = App.prediction.calculateVisiblePasses(sat, App.state.observerCoords, { days: 3 });
					const passesWithInfo = passes.map(p => ({ ...p, satName: sat.name, tle: sat.tle }));
					allPasses.push(...passesWithInfo);
				}

				const now = new Date();
				allPasses = allPasses.filter(p => p.start > now);
		
				allPasses.sort((a, b) => a.start - b.start);
		
				if (allPasses.length === 0) {
					passesContainer.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg">No se encontraron próximos pasos visibles para estos satélites desde tu ubicación.</p>`;
				} else {
					this._renderPassesInContainer(allPasses.slice(0, 20), passesContainer);
				}
			},
		
			_renderPassesInContainer(passes, container) {
				container.innerHTML = '';
				let lastDay = '';
				const dayOptions = { month: 'long', day: 'numeric' };
				const timeOptions = { hour: '2-digit', minute: '2-digit' };
		
				passes.forEach(pass => {
					const passDay = App.time.formatCityTime(pass.start, dayOptions);
					if (passDay !== lastDay) {
						lastDay = passDay;
						const header = document.createElement('h3');
						header.className = 'pass-date-header';
						header.textContent = lastDay;
						container.appendChild(header);
					}
		
					const passCard = document.createElement('div');
					passCard.className = 'pass-card pass-card-clickable pass-card-starlink';
					passCard.dataset.tle = pass.tle;
					passCard.dataset.timestamp = pass.start.getTime();
		
					passCard.innerHTML = `
						<div class="flex-grow">
							<span class="font-bold text-base block text-white">${pass.satName}</span>
							<span class="font-mono text-sm text-text-secondary">${App.time.formatCityTime(pass.start, timeOptions)} - ${App.time.formatCityTime(pass.end, timeOptions)}</span>
						</div>
						<div class="font-bold text-lg" style="color: ${App.prediction.getElevationColor(pass.maxElevation)};">
							${pass.maxElevation.toFixed(0)}°
						</div>`;
					
					passCard.onclick = (e) => {
						const target = e.currentTarget;
						App.prediction.handleBestPassClick(target);
					};
					container.appendChild(passCard);
				});
			}
		},
		satellites: {
			async updateTlesFromSource() {
				const cacheKey = App.config.knownTlesCacheKey;
				const now = new Date().getTime();
		
				// 1. Cargar desde el caché para tener datos iniciales rápidos y que la UI no se vea vacía.
				try {
					const cachedData = JSON.parse(localStorage.getItem(cacheKey) || '{}');
					if (cachedData && cachedData.tles) {
						for (const [id, tle] of Object.entries(cachedData.tles)) {
							if (App.config.knownSatellites[id]) {
								App.config.knownSatellites[id].tle = tle;
							}
						}
					}
				} catch (e) { console.error("Error al cargar el caché de TLE conocidos:", e); }
				
				// 2. Verificar si el caché es reciente (menos de 24 horas). Si lo es, no hacemos nada más.
				try {
					const cachedData = JSON.parse(localStorage.getItem(cacheKey));
					if (cachedData && (now - cachedData.timestamp < 24 * 60 * 60 * 1000)) {
						console.log("TLEs de satélites populares cargados desde caché (válido).");
						// Actualiza la UI para ocultar los spinners de carga aunque no se haya hecho un fetch.
						Object.keys(App.config.knownSatellites).forEach(id => {
							const satElement = document.getElementById(`known-sat-${id}`);
							if (satElement) {
								 satElement.classList.add('is-loading'); // Simula carga para consistencia visual
								 setTimeout(() => { // Da un respiro a la UI para reaccionar
									const statusIndicator = satElement.querySelector('.sat-status-indicator');
									const favBtn = satElement.querySelector('.favorite-btn');
									if (statusIndicator) statusIndicator.classList.add('hidden');
									if (favBtn) favBtn.classList.remove('hidden');
									satElement.classList.remove('is-loading');
									App.mySatellites.updateFavoriteIcons();
								 }, 100);
							}
						});
						App.ui.showDailyUpdate(); // Vuelve a ejecutar con los TLEs de caché.
						return; // Salimos de la función para no volver a pedirlos a la red.
					}
				} catch (e) { /* El caché no existe o es inválido, continuamos para buscar datos nuevos */ }
				
				console.log("Actualizando TLEs de satélites populares desde CelesTrak...");
				const freshTles = {};
		
				// 3. Si el caché es viejo o no existe, buscamos los datos nuevos como antes.
				for (const [id, sat] of Object.entries(App.config.knownSatellites)) {
					const satElement = document.getElementById(`known-sat-${id}`);
					const statusIndicator = satElement?.querySelector('.sat-status-indicator');
					const favBtn = satElement?.querySelector('.favorite-btn');
		
					const handleSuccess = () => {
						if (statusIndicator) statusIndicator.classList.add('hidden');
						if (favBtn) favBtn.classList.remove('hidden');
						satElement.classList.remove('is-loading');
						App.mySatellites.updateFavoriteIcons();
					};
					const handleError = () => {
						if (statusIndicator) statusIndicator.innerHTML = `<span class="text-red-400">${App.language.getTranslation('errorLabel')}</span>`;
						satElement.classList.add('is-error');
					};
		
					satElement.classList.add('is-loading');
					try {
						const response = await fetch(`https://corsproxy.io/?https://celestrak.org/NORAD/elements/gp.php?CATNR=${sat.noradId}&FORMAT=TLE`);
						if (!response.ok) throw new Error(`HTTP error ${response.status}`);
						const tleText = await response.text();
						if (tleText && tleText.includes('1 ') && tleText.includes('2 ')) {
							const trimmedTle = tleText.trim();
							App.config.knownSatellites[id].tle = trimmedTle;
							freshTles[id] = trimmedTle;
							handleSuccess();
						} else { throw new Error('Invalid TLE data'); }
					} catch (error) {
						console.error(`Fallo en la actualización de TLE para ${sat.name}:`, error);
						if (App.config.knownSatellites[id].tle) {
							handleSuccess();
						} else {
							handleError();
						}
					}
				}
		
				const mySats = App.mySatellites.loadFromStorage();
				if (mySats.length === 0) {
					const defaultFavorites = Object.values(App.config.knownSatellites)
						.filter(sat => sat.tle)
						.map(sat => ({ name: sat.name, tle: sat.tle }));
					
					if (defaultFavorites.length > 0) {
						App.mySatellites.saveToStorage(defaultFavorites);
						App.mySatellites.updateFavoriteIcons();
						App.mySatellites.renderFavoriteSatellitesOnKnownScreen();
					}
				}
		
				// 4. Guardar los datos nuevos con la marca de tiempo actual.
				if (Object.keys(freshTles).length > 0) {
					try { 
						const dataToCache = {
							timestamp: now,
							tles: freshTles
						};
						localStorage.setItem(cacheKey, JSON.stringify(dataToCache)); 
					} catch (e) { 
						console.error("Error al guardar el caché de TLE:", e); 
					}
				}
		
				// Vuelve a ejecutar la actualización diaria con los TLEs nuevos.
				App.ui.showDailyUpdate();
			},
			async updateBrightestTlesFromSource() {
				const cacheKey = App.config.brightestTlesCacheKey;
				try {
					const cachedData = JSON.parse(localStorage.getItem(cacheKey));
					const now = new Date().getTime();
					// Cache válido por 24 horas
					if (cachedData && (now - cachedData.timestamp < 24 * 60 * 60 * 1000)) {
						App.config.brightestSatellites = cachedData.sats;
						console.log("Satélites brillantes cargados desde caché.");
                        if (App.elements.brightestSatellitesScreen && !App.elements.brightestSatellitesScreen.classList.contains('hidden')) {
                            App.mySatellites.renderBrightestSatellites();
                        }
						return;
					}
				} catch (e) {
					console.error("Error al cargar caché de satélites brillantes:", e);
				}

                // Si no hay caché válido, se muestra el modal de carga antes de hacer la petición
                App.ui.showLoadingModal('calculating');
				try {
                    const celestrakUrl = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle';
                    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(celestrakUrl)}`;
					const response = await fetch(proxyUrl);
					if (!response.ok) throw new Error(`HTTP error ${response.status}`);
					const tleText = await response.text();
					const parsedSats = this.parseTLE(tleText);

					App.config.brightestSatellites = parsedSats.map(sat => ({
						name: sat.name,
						tle: `${sat.name}\n${sat.line1}\n${sat.line2}`
					}));
					
					localStorage.setItem(cacheKey, JSON.stringify({
						timestamp: new Date().getTime(),
						sats: App.config.brightestSatellites
					}));
					console.log("Satélites brillantes actualizados desde CelesTrak.");

					if (App.elements.brightestSatellitesScreen && !App.elements.brightestSatellitesScreen.classList.contains('hidden')) {
						App.mySatellites.renderBrightestSatellites();
					}

				} catch (error) {
					console.error("Fallo en la actualización de TLE para satélites brillantes:", error);
                    App.ui.showToast('Error al cargar satélites brillantes.', 'error');
				} finally {
                    // Se asegura de ocultar el modal de carga, incluso si hubo un error
                    App.ui.hideLoadingModal();
                }
			},
			loadKnown(satId) {
				App.state.isAllSatellitesMode = false;
				const satData = App.config.knownSatellites[satId];
				if (!satData || !satData.tle) {
					App.playSound('error', 'D3');
					console.error(`TLE para ${satData.name} no está disponible.`);
					return;
				}
				App.playSound('success', 'G4'); 
				try { localStorage.setItem(App.config.lastSatStorageKey, satData.tle); } catch(e) { console.error("Error guardando último satélite:", e); }
				App.elements.tleInput.value = satData.tle;
				this.handleTleLoad(true); 
				App.navigation.go('app-container');
			},
			handleTleLoad(isSilent = false, isMulti = false) {
				const { tleInput, satelliteInfoHeader, satelliteNameDisplay, mainControlPanel } = App.elements; 
				const tleData = tleInput.value;
				if (!tleData.trim()) { if (!isSilent) App.playSound('error', 'C3'); return; }
				this.clearMapLayers(); App.state.trackedSatellites = [];
				App.state.selectedSatForOrbit = null;

				App.state.isSpecialOrbitModeActive = false;
				App.state.nextVisiblePass = null;

				const parsedSatellites = this.parseTLE(tleData);
				if (parsedSatellites.length === 0) { 
					if (!isSilent) App.playSound('error', 'C3'); 
					return; 
				}
				parsedSatellites.forEach(sat => { try { 
					const satrec = satellite.twoline2satrec(sat.line1, sat.line2); 
					const tleString = `${sat.name}\n${sat.line1}\n${sat.line2}`;
					App.state.trackedSatellites.push({ 
						name: sat.name, 
						satrec, 
						tle: tleString,
						markers: [], 
						orbitLayers: [], 
						timeLabelLayers: [], 
						lastBearing: 0 
					}); 
				} catch(e) { console.error("Error processing TLE for:", sat.name, e); } });
				if (App.state.trackedSatellites.length > 0) {
					const count = App.state.trackedSatellites.length; 
					let satName;
					if (App.state.isAllSatellitesMode) {
						satName = App.language.getTranslation('allSatellitesLabel').replace('{count}', count);
					} else {
						const key = count > 1 ? 'multiSatellitesLabel' : 'singleSatelliteLabel';
						const name = App.state.trackedSatellites[0].name || App.language.getTranslation('defaultSatName');
						satName = App.language.getTranslation(key).replace('{count}', count).replace('{name}', name);
					}
					satelliteNameDisplay.textContent = satName; 
					satelliteInfoHeader.classList.remove('hidden'); 
					mainControlPanel.classList.add('satellite-loaded');
					if (!isSilent) App.playSound('success', 'G4');
				}
				App.ui.updateButtonsState();
			},
			parseTLE(tleString) {
				const lines = tleString.trim().split('\n').map(l => l.trim()), satellites = [];
				for (let i = 0; i < lines.length; i++) {
					let name, line1, line2; const isLine1 = (l) => l?.startsWith('1 '), isLine2 = (l) => l?.startsWith('2 ');
					if (!isLine1(lines[i]) && isLine1(lines[i+1]) && isLine2(lines[i+2])) { name = lines[i]; line1 = lines[i+1]; line2 = lines[i+2]; satellites.push({ name, line1, line2 }); i += 2; } 
					else if (isLine1(lines[i]) && isLine2(lines[i+1])) { name = `SAT-${lines[i].substring(2, 7)}`; line1 = lines[i]; line2 = lines[i+1]; satellites.push({ name, line1, line2 }); i += 1; }
				}
				return satellites;
			},
			handleTracking(avoidCentering = false) { 
				if (App.state.isNearbyModeActive) this.nearbyMode.stop();
				this.clearMapLayers();
		
				const satCount = App.state.trackedSatellites.length;
				const isMultiSelect = satCount > 1 && !App.state.isAllSatellitesMode;
				
				const sliderContainer = App.elements.timelineSlider.closest('.w-full.py-2');
				App.elements.timelineSlider.disabled = isMultiSelect;
				if (sliderContainer) {
					sliderContainer.style.opacity = isMultiSelect ? 0.5 : 1;
					sliderContainer.style.pointerEvents = isMultiSelect ? 'none' : 'auto';
					sliderContainer.style.cursor = isMultiSelect ? 'not-allowed' : 'grab';
					sliderContainer.title = isMultiSelect ? App.language.getTranslation('timelineSliderDisabled') : App.language.getTranslation('timelineSlider');
				}
				
				const initialPositions = App.state.trackedSatellites.map(sat => {
					if (!sat.satrec) return null;
					try {
						const posVel = satellite.propagate(sat.satrec, new Date(App.state.currentTime));
						const gmst = satellite.gstime(new Date(App.state.currentTime));
						const posGd = satellite.eciToGeodetic(posVel.position, gmst);
						return {
							lat: satellite.radiansToDegrees(posGd.latitude),
							lon: satellite.radiansToDegrees(posGd.longitude)
						};
					} catch (e) { return null; }
				});
		
				const offsets = [0, 360, -360, 720, -720];
				App.state.trackedSatellites.forEach((sat, satIndex) => {
					if (!sat.satrec) return;
		
					const initialPos = initialPositions[satIndex];
					if (!initialPos) return;
		
					const icon = L.divIcon({ 
						className: '',
						html: `<div class="satellite-marker-wrapper">
								<svg width="22" height="22" viewBox="0 0 24 24" class="satellite-triangle-icon">
									<polygon points="12,2 20,22 4,22" stroke="rgba(255,255,255,0.8)" stroke-width="1.5" />
								</svg>
							</div>`,
						iconSize: [22, 22],
						iconAnchor: [11, 11]
					});
					
					offsets.forEach(offset => {
						const marker = L.marker([initialPos.lat, initialPos.lon + offset], { icon: icon })
							.addTo(App.state.map)
							.bindTooltip(`<span class="sat-name-span" data-tle-id='${getTleId(sat.tle)}'>${sat.name}</span><i class="fa-solid fa-circle-info sat-info-icon" data-tle-id='${getTleId(sat.tle)}'></i>`, { permanent: true, direction: 'right', offset: [15, 0], className: 'satellite-label', interactive: true });
						
						// El manejador de clics ahora está centralizado en setupEventListeners para mayor robustez.

						if (App.state.isAllSatellitesMode) {
							marker.on('click', () => {
								App.playSound('uiClick', 'E4');
								this.drawOrbitOnClick(sat);
							});
						}
						
						sat.markers.push(marker);
					});
				});
			
				this.updatePositions(); 
				
				if (!App.state.isAllSatellitesMode) {
					this.drawOrbits();
				}
		
				App.prediction.findNextVisiblePass();
				App.time.updateSpecialOrbitMode();
				App.time.startRealTimeUpdates();
				App.time.updateTimeUI();
			},
			updatePositions() {
				if (App.state.isNearbyModeActive) return;
				const { map, currentTime, observerCoords, isSpecialOrbitModeActive, isPassViewActive } = App.state;
				const offsets = [0, 360, -360, 720, -720];
				let failedSatellites = [];
			
				App.state.trackedSatellites.forEach((sat, index) => {
					if (!sat.satrec) return;
					
					try {
						const posVel = satellite.propagate(sat.satrec, new Date(currentTime));
						const gmst = satellite.gstime(new Date(currentTime));
						const posGd = satellite.eciToGeodetic(posVel.position, gmst);
						const lat = satellite.radiansToDegrees(posGd.latitude);
						const lon = satellite.radiansToDegrees(posGd.longitude);

						let isVisible = true;
						if (observerCoords && (isSpecialOrbitModeActive || isPassViewActive)) {
							const isObserverDark = App.prediction._isObserverInDarkness(new Date(currentTime), observerCoords);
							const isSatInSunlight = App.prediction.isSatIlluminated(posVel.position, new Date(currentTime));
							const observerGd = { latitude: satellite.degreesToRadians(observerCoords[0]), longitude: satellite.degreesToRadians(observerCoords[1]), height: 0.1 };
							const posEcf = satellite.eciToEcf(posVel.position, gmst);
							const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
							const elevation = satellite.radiansToDegrees(lookAngles.elevation);
							isVisible = isObserverDark && isSatInSunlight && elevation > 10;
						}
			
						const futureTime = new Date(currentTime.getTime() + 1000);
						let bearing = sat.lastBearing || 0;
						try {
							const futurePosVel = satellite.propagate(sat.satrec, new Date(futureTime));
							const futureGmst = satellite.gstime(new Date(futureTime));
							const futurePosGd = satellite.eciToGeodetic(futurePosVel.position, futureGmst);
							const futurePoint = [satellite.radiansToDegrees(futurePosGd.latitude), satellite.radiansToDegrees(futurePosGd.longitude)];
							
							if (Math.abs(lon - futurePoint[1]) < 180) {
								bearing = calculateBearing([lat, lon], futurePoint);
							}
							sat.lastBearing = bearing;
						} catch(e) { /* Fallo en cálculo de bearing ignorado */ }
						
						sat.markers.forEach((marker, index) => {
							const offset = offsets[index];
							marker.setLatLng([lat, lon + offset]);
							const iconEl = marker._icon;
							if (iconEl) {
								const wrapper = iconEl.querySelector('.satellite-marker-wrapper');
								if (wrapper) {
									wrapper.style.transform = `rotate(${bearing}deg)`;
									wrapper.classList.toggle('is-not-visible', !isVisible);
								}
								const tooltipEl = marker.getTooltip()?.getElement();
								if (tooltipEl) {
									tooltipEl.classList.toggle('is-not-visible', !isVisible);
								}
							}
						});
					} catch (e) {
						console.error(`Error de propagación para ${sat.name}. Será removido.`, e);
						failedSatellites.push(sat.tle);
						if (sat.markers) sat.markers.forEach(m => map.removeLayer(m));
						if (sat.orbitLayers) sat.orbitLayers.forEach(layer => map.removeLayer(layer));
					}
				});
			
				if (failedSatellites.length > 0) {
					App.state.trackedSatellites = App.state.trackedSatellites.filter(
						sat => !failedSatellites.includes(sat.tle)
					);
					if (App.state.trackedSatellites.length === 0) {
						App.satellites.clearAll();
					}
				}
			},
			drawOrbitOnClick(clickedSat) {
				const { map } = App.state;
				if (!map) return;
			
				App.state.trackedSatellites.forEach(s => {
					if (s.orbitLayers) {
						s.orbitLayers.forEach(layer => map.removeLayer(layer));
						s.orbitLayers = [];
					}
				});

				if (App.state.selectedSatForOrbit && App.state.selectedSatForOrbit.tle === clickedSat.tle) {
					App.state.selectedSatForOrbit = null;
					return;
				}
			
				App.state.selectedSatForOrbit = clickedSat;
				const satIndex = App.state.trackedSatellites.findIndex(s => s.tle === clickedSat.tle);
				if (satIndex !== -1) {
					this.drawSingleOrbit(satIndex);
				}
			},
			drawSingleOrbit(satIndex) {
				const { map, currentTime } = App.state;
				const sat = App.state.trackedSatellites[satIndex];
				if (!sat || !sat.satrec) return;

				if (sat.orbitLayers) sat.orbitLayers.forEach(layer => map.removeLayer(layer));
				sat.orbitLayers = [];
				if (sat.timeLabelLayers) sat.timeLabelLayers.forEach(layer => map.removeLayer(layer));
				sat.timeLabelLayers = [];
		
				const period = (2 * Math.PI) / sat.satrec.no;
				const step = period / 120;
				const masterPath = [];
				let lastLon = null;
		
				for (let i = 0; i <= period * 1.01; i += step) {
					const time = new Date(currentTime.getTime() + i * 60000);
					try {
						const pnv = satellite.propagate(sat.satrec, new Date(time));
						const gmst = satellite.gstime(new Date(time));
						const posGd = satellite.eciToGeodetic(pnv.position, gmst);
						
						let lat = satellite.radiansToDegrees(posGd.latitude);
						let lon = satellite.radiansToDegrees(posGd.longitude);
		
						if (lastLon !== null) {
							while (lon - lastLon > 180) lon -= 360;
							while (lon - lastLon < -180) lon += 360;
						}
						lastLon = lon;
						masterPath.push([lat, lon]);
					} catch (e) {
						continue;
					}
				}
		
				if (masterPath.length < 2) return;
		
				const offsets = [0, 360, -360, 720, -720];
				offsets.forEach(offset => {
					const offsetPath = masterPath.map(p => [p[0], p[1] + offset]);
					sat.orbitLayers.push(L.polyline(offsetPath, { className: 'orbit-path', pane: 'trajectoryPane' }).addTo(map));
				});
			},
			drawOrbits() {
				const { map, currentTime, observerCoords, isSpecialOrbitModeActive } = App.state;
				const offsets = [0, 360, -360, 720, -720];
			
				App.state.trackedSatellites.forEach(sat => {
					if (sat.orbitLayers) sat.orbitLayers.forEach(layer => map.removeLayer(layer));
					sat.orbitLayers = [];
					if (sat.timeLabelLayers) sat.timeLabelLayers.forEach(layer => map.removeLayer(layer));
					sat.timeLabelLayers = [];
			
					if (!sat.satrec) return;

					const period = (2 * Math.PI) / sat.satrec.no;
					const step = period / 120;
					const masterPath = [];
					let lastLon = null;
			
					for (let i = 0; i <= period * 1.01; i += step) {
						const time = new Date(currentTime.getTime() + i * 60000);
						try {
							const pnv = satellite.propagate(sat.satrec, new Date(time));
							const gmst = satellite.gstime(new Date(time));
							const posGd = satellite.eciToGeodetic(pnv.position, gmst);
							
							let lat = satellite.radiansToDegrees(posGd.latitude);
							let lon = satellite.radiansToDegrees(posGd.longitude);
			
							if (lastLon !== null) {
								while (lon - lastLon > 180) lon -= 360;
								while (lon - lastLon < -180) lon += 360;
							}
							lastLon = lon;
			
							let isVisibleFromCity = false;
							if (isSpecialOrbitModeActive && observerCoords) {
								const isSatInSunlight = App.prediction.isSatIlluminated(pnv.position, time);
								const isObserverDark = App.prediction._isObserverInDarkness(time, observerCoords);
								const observerGd = { latitude: satellite.degreesToRadians(observerCoords[0]), longitude: satellite.degreesToRadians(observerCoords[1]), height: 0.1 };
								const posEcf = satellite.eciToEcf(pnv.position, gmst);
								const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
								const elevation = satellite.radiansToDegrees(lookAngles.elevation);
								
								isVisibleFromCity = isSatInSunlight && isObserverDark && elevation > 10;
							}
			
							masterPath.push({ lat, lon, isVisible: isVisibleFromCity });
						} catch (e) {
							continue;
						}
					}
			
					if (masterPath.length < 2) return;
			
					if (isSpecialOrbitModeActive && observerCoords) {
						const segments = [];
						let currentSegment = { path: [], isVisible: masterPath[0].isVisible };
			
						masterPath.forEach(point => {
							if (point.isVisible !== currentSegment.isVisible) {
								segments.push(currentSegment);
								currentSegment = { path: [currentSegment.path[currentSegment.path.length - 1]], isVisible: point.isVisible };
							}
							currentSegment.path.push([point.lat, point.lon]);
						});
						segments.push(currentSegment);
			
						segments.forEach(segment => {
							if (segment.path.length < 2) return;
							
							const options = {
								className: segment.isVisible ? 'orbit-path' : 'orbit-path-shadow',
								pane: 'trajectoryPane'
							};
			
							offsets.forEach(offset => {
								const offsetPath = segment.path.map(p => [p[0], p[1] + offset]);
								sat.orbitLayers.push(L.polyline(offsetPath, options).addTo(map));
							});
						});
			
					} else {
						const continuousPath = masterPath.map(p => [p.lat, p.lon]);
						offsets.forEach(offset => {
							const offsetPath = continuousPath.map(p => [p[0], p[1] + offset]);
							sat.orbitLayers.push(L.polyline(offsetPath, { className: 'orbit-path', pane: 'trajectoryPane' }).addTo(map));
						});
					}
				});
			},
			centerOnSatellite() {
				if (App.state.trackedSatellites.length > 0 && App.state.map) {
					const sat = App.state.trackedSatellites[0];
					if (sat.markers.length > 0) {
						const targetLatLng = sat.markers[0].getLatLng();
						const currentZoom = App.state.map.getZoom();
						const targetZoom = Math.max(currentZoom, 3); 
			
						if (currentZoom < 2.5) {
							App.state.map.setView(targetLatLng, targetZoom, {
								animate: true,
								pan: { duration: 0.8 }
							});
						} else {
							App.state.map.flyTo(targetLatLng, targetZoom, {
								duration: 1.0, 
								easeLinearity: 0.5
							});
						}
					}
				}
			},
			clearMapLayers() {
				const { map } = App.state;
				if (!map) return;
				App.state.trackedSatellites.forEach(sat => {
					if (sat.markers) sat.markers.forEach(m => { if(map.hasLayer(m)) map.removeLayer(m); });
					sat.markers = [];
					if (sat.orbitLayers) sat.orbitLayers.forEach(layer => map.removeLayer(layer));
					sat.orbitLayers = [];
					if (sat.timeLabelLayers) sat.timeLabelLayers.forEach(layer => map.removeLayer(layer));
					sat.timeLabelLayers = [];
				});
			},
			clearAll() { 
				this.nearbyMode.stop();
				this.clearMapLayers(); 
				App.time.stopTimeTravel(); 
				App.state.trackedSatellites = [];
				App.state.selectedSatForOrbit = null;
				App.state.isAllSatellitesMode = false;
				App.prediction.clearVisibilityBands(); 
				App.elements.satelliteInfoHeader.classList.add('hidden'); 
					App.elements.mainControlPanel.classList.remove('satellite-loaded'); 
				App.elements.satelliteNameDisplay.textContent = ''; 
				App.ui.updateButtonsState();

				const sliderContainer = App.elements.timelineSlider.closest('.w-full.py-2');
				App.elements.timelineSlider.disabled = false;
				if (sliderContainer) {
					sliderContainer.style.opacity = 1;
					sliderContainer.style.pointerEvents = 'auto';
					sliderContainer.style.cursor = 'grab';
					sliderContainer.title = App.language.getTranslation('timelineSlider');
				}
			},
			showInfoModal(sat) {
				// Si no se pasa un satélite específico, intenta usar el primero en la lista (comportamiento anterior).
				if (!sat) {
					if (App.state.trackedSatellites.length === 0) return;
					sat = App.state.trackedSatellites[0];
				}
				
				App.playSound('uiClick', 'E4');
				try {
					const posVel = satellite.propagate(sat.satrec, new Date(App.state.currentTime)); const gmst = satellite.gstime(new Date(App.state.currentTime)); const posGd = satellite.eciToGeodetic(posVel.position, gmst);
					const vel = posVel.velocity; const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
					App.elements.satelliteInfoModalTitle.textContent = sat.name;
					App.elements.satelliteInfoContent.innerHTML = `
						<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
							<div>
								<p class="font-bold text-sm text-text-secondary uppercase tracking-wider" data-lang-key="altitude">${App.language.getTranslation('altitude')}</p>
								<p class="font-mono text-xl text-secondary mt-1">${posGd.height.toFixed(2)} km</p>
							</div>
							<div>
								<p class="font-bold text-sm text-text-secondary uppercase tracking-wider" data-lang-key="speed">${App.language.getTranslation('speed')}</p>
								<p class="font-mono text-xl text-secondary mt-1">${(speed * 3600).toFixed(0)} km/h</p>
							</div>
							<div>
								<p class="font-bold text-sm text-text-secondary uppercase tracking-wider" data-lang-key="magnitudeMax">${App.language.getTranslation('magnitudeMax')}</p>
								<p id="max-magnitude-value" class="font-mono text-xl text-text-secondary mt-1"><i class="fa-solid fa-spinner fa-spin"></i></p>
							</div>
						</div>`;
                    
                    if (App.state.isNearbyModeActive && App.state.observerCoords) {
						this.calculateMaxMagnitudeForPass(sat, App.state.observerCoords)
							.then(maxMag => {
								const maxMagElement = document.getElementById('max-magnitude-value');
								if (maxMagElement) {
									if (maxMag !== null && isFinite(maxMag)) {
										maxMagElement.textContent = maxMag.toFixed(1);
										maxMagElement.classList.remove('text-text-secondary');
										maxMagElement.classList.add('text-warning');
									} else {
										maxMagElement.textContent = '--';
									}
								}
							});

                    } else {
                        const maxMagElement = document.getElementById('max-magnitude-value');
						if (maxMagElement) maxMagElement.textContent = '--';
                    }

				} catch(e) { App.elements.satelliteInfoContent.innerHTML = `<p class="text-danger">${App.language.getTranslation('satInfoError')}</p>`; console.error("Error calculating satellite info:", e); }
				App.ui.showModal(App.elements.satelliteInfoModal);
			},

            async calculateMagnitude(sat, observerCoords, time) {
                if (!sat.satrec || !observerCoords) return null;

                try {
                    const noradId = satcatManager._parseNoradFromTle(sat.tle);
                    if (!noradId) return null;

                    // 1. Obtener magnitud estándar (M₀) usando el método mejorado.
                    const M0 = satcatManager.getStandardMagnitude(noradId);

                    // 2. Obtener posición del satélite y del sol.
                    const posVel = satellite.propagate(sat.satrec, time);
                    const satEci = posVel.position;
                    const sunEci = getSunEci(time);

                    // 3. Verificar si el satélite está iluminado.
                    const isSatInSunlight = App.prediction.isSatIlluminated(satEci, time);
                    if (!isSatInSunlight) return null;

                    // 4. Obtener vector y posición del observador.
                    const gmst = satellite.gstime(time);
                    const observerGd = {
                        latitude: satellite.degreesToRadians(observerCoords[0]),
                        longitude: satellite.degreesToRadians(observerCoords[1]),
                        height: 0.1
                    };
                    const observerEcf = satellite.geodeticToEcf(observerGd);
                    const observerEci = satellite.ecfToEci(observerEcf, gmst);
                    
                    // 5. Calcular vectores para el ángulo de fase.
                    const vec_sat_sun = { x: sunEci.x - satEci.x, y: sunEci.y - satEci.y, z: sunEci.z - satEci.z };
                    const vec_sat_obs = { x: observerEci.x - satEci.x, y: observerEci.y - satEci.y, z: observerEci.z - satEci.z };

                    // 6. Calcular distancia (range) al observador.
                    const range = Math.sqrt(vec_sat_obs.x**2 + vec_sat_obs.y**2 + vec_sat_obs.z**2);

                    // 7. Calcular ángulo de fase (phi).
                    const dotProduct = (vec_sat_sun.x * vec_sat_obs.x) + (vec_sat_sun.y * vec_sat_obs.y) + (vec_sat_sun.z * vec_sat_obs.z);
                    const mag_sat_sun = Math.sqrt(vec_sat_sun.x**2 + vec_sat_sun.y**2 + vec_sat_sun.z**2);
                    const mag_sat_obs = range;
                    const phi = Math.acos(dotProduct / (mag_sat_sun * mag_sat_obs));

                    // 8. Calcular función de fase (modelo de esfera difusa).
                    const phaseFunction = (1 / Math.PI) * (Math.sin(phi) + (Math.PI - phi) * Math.cos(phi));
                    if (phaseFunction <= 0) return null;

                    // 9. Fórmula de magnitud aparente (sin correcciones aún).
                    const magnitude = M0 + 5 * Math.log10(range / 1000) - 2.5 * Math.log10(phaseFunction);
                    
                    // --- NUEVO: Corrección por Extinción Atmosférica ---
                    const posEcf = satellite.eciToEcf(satEci, gmst);
                    const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
                    const elevationRad = lookAngles.elevation;

                    if (elevationRad > 0) {
                        const k = 0.2; // Coeficiente de extinción atmosférica (valor promedio).
                        const airmass = 1 / Math.sin(elevationRad);
                        const extinction = k * airmass;
                        return magnitude + extinction;
                    }
                    
                    // Si el satélite está por debajo del horizonte, no es visible.
                    return null;
                    
                } catch (e) {
                    // Se mantiene el manejo de errores, pero ya no se loguea para cada satélite.
                    // console.error("Error en el cálculo de magnitud para " + sat.name, e);
                    return null;
                }
            },

            async calculateMaxMagnitudeForPass(sat, coords) {
                if (!sat.satrec || !coords) return null;
            
                const passes = App.prediction.calculateVisiblePasses(sat, coords, { days: 1 });
                const now = App.state.currentTime;
            
                const relevantPass = passes.find(p => now >= p.start && now <= p.end) || passes.find(p => p.start > now);
            
                if (!relevantPass) {
                    return null;
                }
            
                let minMagnitude = Infinity;
                const step = 20000; // Calcular cada 20 segundos
            
                for (let time = relevantPass.start.getTime(); time <= relevantPass.end.getTime(); time += step) {
                    const currentMagnitude = await this.calculateMagnitude(sat, coords, new Date(time));
                    if (currentMagnitude !== null && currentMagnitude < minMagnitude) {
                        minMagnitude = currentMagnitude;
                    }
                }
            
                return isFinite(minMagnitude) ? minMagnitude : null;
            },
		},
		location: {
			saveToStorage(loc) { try { localStorage.setItem(App.config.locationStorageKey, JSON.stringify(loc)); } catch (e) { console.error(e); } },
			loadFromStorage() { 
				try { 
					const savedLoc = localStorage.getItem(App.config.locationStorageKey); 
					if (savedLoc) { 
						const { lat, lon, name, timezoneData } = JSON.parse(savedLoc); 
						App.state.observerCoords = [lat, lon];
						App.state.observerTimeZone = timezoneData || null;
						const successText = `${App.language.getTranslation('locationLabel')}: ${name}`;
						this._updateLocationUI(name, 'success', successText);
						App.ui.updateButtonsState();
						App.time.updateClockPill();
					} else {
						this._updateLocationUI('', 'clear', '');
					}
				} catch (e) { console.error(e); } 
			},
			_updateLocationUI(name, status, feedbackText) {
				const { locationInput, bestPassesLocationInput, locationFeedback, bestPassesLocationFeedback, locationSearchIcon, bestPassesLocationSearchIcon, locationSearchBtn, bestPassesLocationSearchBtn } = App.elements;

				locationInput.value = name;
				bestPassesLocationInput.value = name;

				const isError = status === 'error';
				const isLoading = status === 'loading';
				const isSuccess = status === 'success';
				const isClear = status === 'clear' || !feedbackText;

				let currentFeedbackText = feedbackText;
				let feedbackClass = '';

				const feedbackElements = [locationFeedback, bestPassesLocationFeedback];

				if (isClear) {
					currentFeedbackText = App.language.getTranslation('addLocationManually');
					feedbackClass = 'text-text-secondary manual-location-prompt';
					feedbackElements.forEach(el => {
						if(el) el.onclick = App.location.enterManualMode;
					});
				} else {
					feedbackElements.forEach(el => {
						if(el) el.onclick = null;
					});
					if (isSuccess) {
						feedbackClass = 'text-green-400';
					} else if (isError) {
						feedbackClass = 'text-red-400';
					} else if (isLoading) {
						feedbackClass = 'text-blue-400';
					}
				}

				locationFeedback.textContent = currentFeedbackText;
				locationFeedback.className = `text-xs text-center mt-1 h-4 ${feedbackClass}`;
				
				bestPassesLocationFeedback.textContent = currentFeedbackText;
				bestPassesLocationFeedback.className = `text-xs text-center ${feedbackClass}`;
				
				const icons = [locationSearchIcon, bestPassesLocationSearchIcon];
				const buttons = [locationSearchBtn, bestPassesLocationSearchBtn];
				
				icons.forEach(icon => {
					if (!icon) return;
					icon.classList.toggle('fa-magnifying-glass', !isSuccess);
					icon.classList.toggle('fa-xmark', isSuccess);
					icon.classList.toggle('fa-spin', isLoading);
				});
				buttons.forEach(button => {
					if (!button) return;
					const titleKey = isSuccess ? 'clearSearch' : 'searchLocation';
					button.setAttribute('title', App.language.getTranslation(titleKey));
					button.disabled = isLoading;
				});
			},
			applySavedLocationToMap() {
				if (App.state.observerCoords && App.state.mapInitialized) {
					App.state.userLocationMarkers.forEach(m => App.state.map.removeLayer(m));
					App.state.userLocationMarkers = [];
					
					const offsets = [0, 360, -360, 720, -720];
					const icon = L.divIcon({ className: '', html: '<div class="user-location-icon"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });

					offsets.forEach(offset => {
						const coords = [App.state.observerCoords[0], App.state.observerCoords[1] + offset];
						const marker = L.marker(coords, { icon: icon }).addTo(App.state.map);
						App.state.userLocationMarkers.push(marker);
					});
				}
			},
			async handleCitySearch(cityName, shouldRecalculatePasses = false, type) {
				if (!type) {
					console.error("handleCitySearch fue llamado sin un tipo ('map' o 'bestPasses').");
					return;
				}
			
				// Aborta cualquier fetch anterior de la misma barra para evitar condiciones de carrera.
				if (App.state.geocodeControllers[type]) {
					App.state.geocodeControllers[type].abort();
				}
			
				// Maneja la limpieza de la ubicación si el input está vacío.
				if (cityName.trim().length === 0) {
					App.state.observerCoords = null;
					App.state.observerTimeZone = null;
					this._updateLocationUI('', 'clear', '');
					localStorage.removeItem(App.config.locationStorageKey);
					App.time.updateClockPill();
					App.ui.updateButtonsState();
					App.ui.showDailyUpdate();
					if (shouldRecalculatePasses) App.prediction.showBestPasses();
					App.satellites.drawOrbits();
					return;
				}
			
				this._updateLocationUI(cityName, 'loading', App.language.getTranslation('searching'));
				
				App.state.geocodeControllers[type] = new AbortController();
				const { signal } = App.state.geocodeControllers[type];
		
				// Timeout manual: si la búsqueda tarda más de 8 segundos, se cancela.
				const requestTimeout = setTimeout(() => {
					App.state.geocodeControllers[type].abort();
				}, 8000);
		
				try {
					const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1&accept-language=es`, {
						signal,
						headers: { 'User-Agent': 'SatelitesArg/1.0 (satelitesargentina@gmail.com)' } // User-Agent requerido por Nominatim.
					});
					
					clearTimeout(requestTimeout); // Si la respuesta llega a tiempo, cancela el timeout.
		
					if (!response.ok) throw new Error(`Error de red: ${response.status}`);
					
					const data = await response.json();
		
					if (data && data.length > 0) {
						// --- Procesa la respuesta exitosa (esta lógica es la misma que antes) ---
						const { lat, lon, display_name } = data[0];
						const simpleName = display_name.split(',')[0];
						App.state.observerCoords = [parseFloat(lat), parseFloat(lon)];
		
						try {
							const tzResponse = await fetch(`https://corsproxy.io/?https://timeapi.io/api/TimeZone/coordinate?latitude=${lat}&longitude=${lon}`, { signal });
							if (tzResponse.ok) {
								const timezoneData = await tzResponse.json();
								App.state.observerTimeZone = timezoneData;
								this.saveToStorage({ lat: parseFloat(lat), lon: parseFloat(lon), name: simpleName, timezoneData });
							} else { throw new Error('API de zona horaria falló'); }
						} catch (tzError) {
							console.error("No se pudo obtener la zona horaria, se usará UTC como fallback", tzError);
							App.state.observerTimeZone = null;
							this.saveToStorage({ lat: parseFloat(lat), lon: parseFloat(lon), name: simpleName, timezoneData: null });
						}
		
						App.time.updateTimeUI();
						this._updateLocationUI(simpleName, 'success', `${App.language.getTranslation('locationLabel')}: ${simpleName}`);
						setTimeout(() => App.elements.bestPassesLocationFeedback.classList.remove('is-visible'), 2000);
						App.playSound('success', 'E4');
						if (App.state.map) {
							this.applySavedLocationToMap();
							App.state.map.flyTo(App.state.observerCoords, 5, { duration: 0.8 });
						}
						App.time.updateClockPill();
						if (shouldRecalculatePasses) App.prediction.showBestPasses();
						App.prediction.findNextVisiblePass();
						App.time.updateSpecialOrbitMode();
						App.satellites.drawOrbits();
						App.ui.showDailyUpdate();
					} else {
						this.setError(App.language.getTranslation('cityNotFound'));
					}
				} catch (error) {
					clearTimeout(requestTimeout); // Asegura que el timeout se limpie también en caso de error.
					if (error.name !== 'AbortError') {
						console.error('Error en geocodificación:', error);
						this.setError(App.language.getTranslation('networkError'));
						App.ui.showToast(App.language.getTranslation('networkError'), 'error');
					} else {
						console.log("Búsqueda abortada (nueva búsqueda, timeout o limpieza manual).");
						const currentInput = (type === 'map') ? App.elements.locationInput : App.elements.bestPassesLocationInput;
						if (currentInput.value === cityName) {
							this.setError(App.language.getTranslation('networkError'));
						}
					}
				} finally {
					App.ui.updateButtonsState();
				}
			},
			setError(msg) { 
				App.state.observerCoords = null; 
				App.state.observerTimeZone = null;
				this._updateLocationUI(App.elements.locationInput.value, 'error', msg);
				App.playSound('error', 'C3'); 
			},
			clear() { App.state.userLocationMarkers.forEach(m => App.state.map.removeLayer(m)); App.state.userLocationMarkers = []; App.elements.locationInput.value = ''; App.elements.locationFeedback.textContent = ''; App.state.observerCoords = null; App.state.observerTimeZone = null; localStorage.removeItem(App.config.locationStorageKey); App.time.updateClockPill(); },
			
			enterManualMode() {
				if (App.state.isManualLocationMode || !App.state.map) return;
				App.playSound('uiClick', 'A3');
				App.state.isManualLocationMode = true;

				const feedbackElements = [App.elements.locationFeedback, App.elements.bestPassesLocationFeedback];
				feedbackElements.forEach(el => {
					if (el) {
						el.textContent = App.language.getTranslation('manualLocationActive');
						el.className = el.className.replace('manual-location-prompt', 'manual-location-active');
						el.onclick = null; // Quita el listener para evitar re-activar
					}
				});
				
				App.state.map.getContainer().style.cursor = 'crosshair';
				// Usamos .bind(this) para mantener el contexto de App.location dentro del handler
				App.state.map.on('click', App.location.handleManualMapClick, App.location);
				App.ui.showToast(App.language.getTranslation('manualLocationInstructions'), 'success');
			},

			exitManualMode() {
				if (!App.state.isManualLocationMode) return;
				App.state.isManualLocationMode = false;
				if (App.state.map) {
					App.state.map.getContainer().style.cursor = '';
					App.state.map.off('click', App.location.handleManualMapClick, App.location);
				}
				// Restaura el estado visual de los inputs de ubicación
				App.location.loadFromStorage();
			},
			
			handleManualMapClick(e) {
				const { lat, lng } = e.latlng;
				this.setManualLocation(lat, lng);
			},

			async setManualLocation(lat, lon) {
				if (!App.state.isManualLocationMode) return;
				
				App.playSound('success', 'E4');
				App.ui.showLoadingModal('searching');
				App.state.map.off('click', this.handleManualMapClick, this);


				try {
					// Reverse geocoding para obtener un nombre
					const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=es`, {
						headers: { 'User-Agent': 'SatelitesArg/1.0 (satelitesargentina@gmail.com)' }
					});
					if (!response.ok) throw new Error('Reverse geocoding failed');
					const data = await response.json();
					const address = data.address;
					const simpleName = address.city || address.town || address.village || data.display_name.split(',')[0] || App.language.getTranslation('manualLocationName');

					// Obtener zona horaria
					App.state.observerCoords = [lat, lon];
					try {
						const tzResponse = await fetch(`https://corsproxy.io/?https://timeapi.io/api/TimeZone/coordinate?latitude=${lat}&longitude=${lon}`);
						if (tzResponse.ok) {
							const timezoneData = await tzResponse.json();
							App.state.observerTimeZone = timezoneData;
							this.saveToStorage({ lat, lon, name: simpleName, timezoneData });
						} else { throw new Error('Timezone API failed'); }
					} catch (tzError) {
						console.warn("Could not get timezone, falling back to UTC", tzError);
						App.state.observerTimeZone = null;
						this.saveToStorage({ lat, lon, name: simpleName, timezoneData: null });
					}
					
					// Actualizar toda la UI
					this._updateLocationUI(simpleName, 'success', `${App.language.getTranslation('locationLabel')}: ${simpleName}`);
					this.applySavedLocationToMap();
					App.ui.updateButtonsState();
					App.time.updateClockPill();
					App.prediction.findNextVisiblePass();
					App.time.updateSpecialOrbitMode();
					App.satellites.drawOrbits();
					App.ui.showDailyUpdate();

				} catch (error) {
					console.error("Error setting manual location:", error);
					App.ui.showToast(App.language.getTranslation('networkError'), 'error');
					App.state.observerCoords = null; // Limpia si falla
				} finally {
					App.state.isManualLocationMode = false;
					if (App.state.map) App.state.map.getContainer().style.cursor = '';
					App.ui.hideLoadingModal();
					this.exitManualMode();
				}
			}
		},
		prediction: {
			_isObserverInDarkness(time, coords) {
				const sunTimes = SunCalc.getTimes(time, coords[0], coords[1]);
				const gracePeriod = App.config.predictionGracePeriodMinutes * 60000; 

				const eveningLimit = new Date(sunTimes.sunset.getTime() + gracePeriod);
				const morningLimit = new Date(sunTimes.sunrise.getTime() - gracePeriod);

				return time > eveningLimit || time < morningLimit;
			},
			handlePrediction() {
                if (App.state.trackedSatellites.length === 0 || !App.state.observerCoords) return;
            
                // 1. Mostramos ambas ventanas (la de carga y el modal de fondo) inmediatamente.
                App.ui.showLoadingModal('calculating');
                App.elements.passesModalTitle.textContent = App.language.getTranslation('passesModalTitle');
                App.ui.showModal(App.elements.passesModal);
                App.playSound('uiClick', 'D4');
            
                const sats = App.state.trackedSatellites.map(s => ({ name: s.name, tle: s.tle }));
                
                // 2. Envolvemos el inicio del cálculo en un setTimeout.
                setTimeout(() => {
                    this.startPassCalculation(sats, 'modal');
                }, 0);
            },
			calculateVisiblePasses(sat, coords, options = {}) {
				const { days = App.config.predictionFutureDays, direction = 'future', startDate = new Date() } = options;
				const observerGd = { latitude: satellite.degreesToRadians(coords[0]), longitude: satellite.degreesToRadians(coords[1]), height: 0.1 }; 
				
                const baseDate = new Date(startDate);
                if (direction === 'future') {
                    baseDate.setHours(0, 0, 0, 0); 
                }

				const totalMinutes = days * 24 * 60; 
                const finalPasses = []; 
                let inPass = false, currentPass = null;
				
				for (let i = 0; i < totalMinutes; i += (1 / 60)) {
					const timeOffset = (direction === 'future' ? i : -i) * 60000;
					const time = new Date(baseDate.getTime() + timeOffset);

					try {
						const posVel = satellite.propagate(sat.satrec, new Date(time));
						const gmst = satellite.gstime(new Date(time));
						const posEcf = satellite.eciToEcf(posVel.position, gmst);
						const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
						const elevation = satellite.radiansToDegrees(lookAngles.elevation);
						
						if (elevation > 10 && !inPass) {
							inPass = true;
							currentPass = { 
								start: time, 
								end: null,
								visibleStart: null,
								visibleEnd: null,
								maxElevation: 0,
								points: [], 
								hasVisibleSegment: false, 
								isPast: direction === 'past' 
							};
						}

						if (inPass) {
							const isObserverInDarkness = this._isObserverInDarkness(time, coords);
							const isSatInSunlight = this.isSatIlluminated(posVel.position, time);
							const isVisibleNow = isObserverInDarkness && isSatInSunlight;
							
							currentPass.points.push({ time, elevation, isVisible: isVisibleNow, az: lookAngles.azimuth });
							
							if (isVisibleNow) {
								if (!currentPass.visibleStart) {
									currentPass.visibleStart = time;
								}
								currentPass.visibleEnd = time;
								currentPass.hasVisibleSegment = true;
								
								if (elevation > currentPass.maxElevation) {
									currentPass.maxElevation = elevation;
								}
							}
						}

						if (elevation < 10 && inPass) {
							inPass = false;
							currentPass.end = time;

							if (currentPass.hasVisibleSegment && currentPass.points.length > 1) {
								if (currentPass.visibleStart && currentPass.visibleEnd) {
									currentPass.start = currentPass.visibleStart;
									currentPass.end = currentPass.visibleEnd;
								}
                                const firstVisiblePoint = currentPass.points.find(p => p.time.getTime() === currentPass.start.getTime());
                                const allVisiblePoints = currentPass.points.filter(p => p.time.getTime() >= currentPass.start.getTime() && p.time.getTime() <= currentPass.end.getTime());
                                const lastVisiblePoint = allVisiblePoints[allVisiblePoints.length - 1];
                                
                                if (firstVisiblePoint) currentPass.startAz = firstVisiblePoint.az;
                                if (lastVisiblePoint) currentPass.endAz = lastVisiblePoint.az;
								
                                finalPasses.push(currentPass);
							}
							if (direction === 'future' && finalPasses.length >= App.config.maxPassesToCalculate) break;
						}
					} catch (e) { inPass = false; continue; }
				}
				return finalPasses;
			},
			getCardinalDirection(azimuthDegrees) {
                const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
                const index = Math.round((((azimuthDegrees % 360) + 360) % 360) / 45) % 8;
                return directions[index];
            },
			getElevationColor(elevation) { const factor = (Math.max(10, Math.min(90, elevation)) - 10) / 80; const r = Math.round(100 + (250 - 100) * factor), g = Math.round(100 + (220 - 100) * factor), b = Math.round(100 + (40 - 100) * factor); return `rgb(${r}, ${g}, ${b})`; },
			
			displayPasses(passesToDisplay, append = false) {
                const { resultsContainer } = App.elements;
                const now = new Date();
                const futurePasses = passesToDisplay.filter(p => p.start > now);
                const passesToRender = this.filterPasses(futurePasses);

                if (!append) {
                    resultsContainer.innerHTML = '';
                } else {
                    const spinner = resultsContainer.querySelector('.calculating-spinner');
                    if (spinner) spinner.remove();
                }
                
                const fragment = document.createDocumentFragment();

                if (passesToRender.length === 0 && !append) {
                    // Se envuelve el mensaje en un div con flexbox para centrarlo verticalmente en el contenedor de altura fija
                    resultsContainer.innerHTML = `
                        <div class="flex items-center justify-center h-full">
                            <p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg" data-lang-key="noPassesForFilter">${App.language.getTranslation('noPassesForFilter')}</p>
                        </div>`;
                } else {
                    let lastDay = resultsContainer.lastElementChild?.dataset.day || '';
                    const dayOptions = { month: 'long', day: 'numeric' };
                    const timeOptions = { hour: '2-digit', minute: '2-digit' };
                    let itemDelayIndex = resultsContainer.children.length;
                    
                    const today = new Date();
                    const todayString = App.time.formatCityTime(today, { year: 'numeric', month: 'numeric', day: 'numeric' });
                    
                    const listWrapper = document.createElement('div');
                    listWrapper.className = 'space-y-3';

                    passesToRender.forEach(pass => {
                        const passDay = App.time.formatCityTime(pass.start, dayOptions);
                        if (passDay !== lastDay) {
                            lastDay = passDay;
                            const header = document.createElement('h3');
                            header.className = 'pass-date-header list-item-animation';
                            header.textContent = lastDay;
                            header.dataset.day = lastDay;
                            header.style.animationDelay = `${itemDelayIndex * 30}ms`;
                            listWrapper.appendChild(header);
                            itemDelayIndex++;
                        }

                        const passInfo = { satName: pass.satName, start: pass.start.getTime(), end: pass.end.getTime(), maxElevation: pass.maxElevation, tle: pass.tle };
                        const passInfoString = JSON.stringify(passInfo).replace(/"/g, '&quot;');

                        const passCard = document.createElement('div');
                        const passDateString = App.time.formatCityTime(pass.start, { year: 'numeric', month: 'numeric', day: 'numeric' });
                        const isToday = passDateString === todayString;

                        passCard.className = `pass-card pass-card-clickable list-item-animation ${pass.isPast ? 'previous-pass' : ''} ${isToday ? 'pass-card-today' : ''}`;
                        passCard.style.animationDelay = `${itemDelayIndex * 30}ms`;
                        itemDelayIndex++;
                        passCard.dataset.tle = pass.tle;

                        passCard.innerHTML = `
                            <div class="flex-grow">
                                <span class="font-bold text-base block text-white">${pass.satName}</span>
                                <span class="font-mono text-sm text-text-secondary">${App.time.formatCityTime(pass.start, timeOptions)} - ${App.time.formatCityTime(pass.end, timeOptions)}</span>
                            </div>
                            <div class="flex items-center flex-shrink-0">
								<div class="mr-4 text-center">
									<div class="pass-elevation-label" style="color: ${this.getElevationColor(pass.maxElevation)};">ELEV.<br>MÁX.</div>
									<div class="font-bold text-lg" style="color: ${this.getElevationColor(pass.maxElevation)};">
										${pass.maxElevation.toFixed(0)}°
									</div>
								</div>
                                <div class="notification-pill">
                                    <button class="notification-btn" data-lang-key="notifyMe" title="${App.language.getTranslation('notifyMe').title}" data-pass-info='${passInfoString}'>
                                        <i class="fa-regular fa-bell text-lg"></i>
                                    </button>
                                    <button class="add-to-calendar-btn" data-lang-key="addToCalendar" title="${App.language.getTranslation('addToCalendar').title}" data-pass-info='${passInfoString}'>
                                        <i class="fa-regular fa-calendar-plus text-lg"></i>
                                    </button>
                                </div>
                            </div>`;
                        
                        const passId = App.notifications._getPassId(pass);
                        const scheduled = App.notifications._loadScheduled();
                        if (scheduled[passId] && scheduled[passId].length > 0) {
                            const notifyBtn = passCard.querySelector('.notification-btn');
                            if (notifyBtn) {
                                const icon = notifyBtn.querySelector('i');
                                if (icon) icon.classList.replace('fa-regular', 'fa-solid');
                                notifyBtn.style.color = 'var(--color-success)';
                            }
                        }

                        passCard.onclick = (e) => {
                            if (!e.target.closest('.notification-pill button')) {
                                this.jumpToPassTime(pass.start.getTime(), e.currentTarget.dataset.tle);
                            }
                        };
                        const calendarBtn = passCard.querySelector('.add-to-calendar-btn');
                        calendarBtn.onclick = (e) => this.handleAddToCalendarClick(e);

                        const notifyBtn = passCard.querySelector('.notification-btn');
                        notifyBtn.onclick = (e) => App.notifications.openModal(e.currentTarget.dataset.passInfo, e.currentTarget);

                        listWrapper.appendChild(passCard);
                    });
                    fragment.appendChild(listWrapper);
                }
                
                resultsContainer.appendChild(fragment);
                App.ui.hideLoadingModal();
			},
			filterPasses(passes) {
                const { currentPassFilter, observerCoords } = App.state;
                if (currentPassFilter === 'all' || !observerCoords) {
                    return passes;
                }

                return passes.filter(pass => {
                    const sunTimes = SunCalc.getTimes(pass.start, observerCoords[0], observerCoords[1]);
                    const passStartTime = pass.start.getTime();

                    if (currentPassFilter === 'dusk') { // Anochecer
                        const duskStart = sunTimes.sunset.getTime();
                        const duskEnd = duskStart + (3 * 60 * 60 * 1000); // 3 horas después
                        return passStartTime >= duskStart && passStartTime <= duskEnd;
                    }

                    if (currentPassFilter === 'dawn') { // Amanecer
                        const dawnEnd = sunTimes.sunrise.getTime();
                        const dawnStart = dawnEnd - (3 * 60 * 60 * 1000); // 3 horas antes
                        return passStartTime >= dawnStart && passStartTime <= dawnEnd;
                    }
                    return false;
                });
            },
			showBestPasses() {
                const { bestPassesList, showPreviousBestPassesBtn, viewMoreContainerBestPasses, showPreviousContainer } = App.elements;
                showPreviousContainer.classList.add('hidden');
                showPreviousContainer.style.transform = 'translateY(-100%)';
                showPreviousContainer.style.opacity = '0';

                showPreviousBestPassesBtn.disabled = false;
                showPreviousBestPassesBtn.textContent = App.language.getTranslation('showPreviousPasses');
                App.state.previousBestPassesLoaded = false;
                
                const source = App.state.currentBestPassesSource;
                let satsToCalculate = [];

                if (source === 'all') {
                    const allSatsMap = new Map();
                    const addSatToMap = (sat) => { if (!sat || !sat.tle) return; const tleId = getTleId(sat.tle); if (tleId && !allSatsMap.has(tleId)) { allSatsMap.set(tleId, sat); } };
                    App.mySatellites.loadFromStorage().forEach(addSatToMap);
                    Object.values(App.config.knownSatellites).forEach(addSatToMap);
                    App.config.latestStarlinks.forEach(addSatToMap);
                    App.config.brightestSatellites.forEach(addSatToMap);
                    satsToCalculate = Array.from(allSatsMap.values());
                } else {
                    satsToCalculate = App.mySatellites.loadFromStorage();
                }
                
                App.ui.showLoadingModal('calculatingBestPasses', { count: satsToCalculate.length });

                if (!App.state.observerCoords) {
                    bestPassesList.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg" data-lang-key="setLocationForBestPasses">${App.language.getTranslation('setLocationForBestPasses')}</p>`;
                    showPreviousContainer.classList.add('hidden');
                    viewMoreContainerBestPasses.classList.add('hidden');
                    App.ui.hideLoadingModal();
                    return;
                }
                
                const cacheKey = `best_passes_cache_${source}_${App.state.observerCoords[0]}_${App.state.observerCoords[1]}`;
                try {
                    const cachedDataString = sessionStorage.getItem(cacheKey);
                    if (cachedDataString) {
                        const cachedData = JSON.parse(cachedDataString);
                        const isCacheValid = (Date.now() - cachedData.timestamp) < App.config.bestPassesCacheTTL;
                        
                        if (isCacheValid && cachedData.passes) {
                            console.log(`Cargando pasos para '${source}' desde la caché.`);
                            cachedData.passes.forEach(pass => {
                                pass.start = new Date(pass.start);
                                pass.end = new Date(pass.end);
                            });
                            App.state.passCalculation.allFoundPasses = cachedData.passes;
                            this.renderFilteredPasses();
                            return;
                        }
                    }
                } catch (e) {
                    console.error("Error al leer la caché de pasos:", e);
                    sessionStorage.removeItem(cacheKey);
                }

                if (satsToCalculate.length === 0) {
                    const key = source === 'favorites' ? 'noFavoritesForBestPasses' : 'noSatsLoaded';
                    bestPassesList.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg" data-lang-key="${key}">${App.language.getTranslation(key)}</p>`;
                    showPreviousBestPassesBtn.classList.add('hidden');
                    viewMoreContainerBestPasses.classList.add('hidden');
                    App.ui.hideLoadingModal();
                    return;
                }
                
                setTimeout(() => {
                    this.startPassCalculation(satsToCalculate, 'bestPasses');
                }, 0);
            },
			async showPreviousBestPasses() {
				const { showPreviousBestPassesBtn, bestPassesList, showPreviousContainer } = App.elements;
				if (App.state.previousBestPassesLoaded) return;

				showPreviousBestPassesBtn.disabled = true;
				showPreviousBestPassesBtn.textContent = App.language.getTranslation('calculating');
				App.playSound('uiClick', 'C4');
				App.ui.showLoadingModal();

				showPreviousContainer.style.transform = 'translateY(-100%)';
				showPreviousContainer.style.opacity = '0';
				setTimeout(() => showPreviousContainer.classList.add('hidden'), 300);

				setTimeout(async () => {
					const source = App.state.currentBestPassesSource;
					let satsToCalculate = [];
					const daysToCalculate = source === 'all' ? 1 : App.config.predictionPastDays;

					if (source === 'all') {
						const allSatsMap = new Map();
						const addSatToMap = (sat) => { if (!sat || !sat.tle) return; const tleId = getTleId(sat.tle); if (tleId && !allSatsMap.has(tleId)) { allSatsMap.set(tleId, sat); } };
						App.mySatellites.loadFromStorage().forEach(addSatToMap);
						Object.values(App.config.knownSatellites).forEach(addSatToMap);
						App.config.latestStarlinks.forEach(addSatToMap);
						App.config.brightestSatellites.forEach(addSatToMap);
						satsToCalculate = Array.from(allSatsMap.values());
					} else {
						satsToCalculate = App.mySatellites.loadFromStorage();
					}

					let previousPasses = [];
					for (const sat of satsToCalculate) {
						const parsed = App.satellites.parseTLE(sat.tle);
						if (parsed.length > 0) {
							const satrec = satellite.twoline2satrec(parsed[0].line1, parsed[0].line2);
							const passes = this.calculateVisiblePasses({ name: sat.name, satrec }, App.state.observerCoords, { days: daysToCalculate, direction: 'past' });
							const bestPasses = passes.filter(p => p.maxElevation > 50).map(p => ({ ...p, satName: sat.name, tle: sat.tle }));
							previousPasses.push(...bestPasses);
						}
					}
					
                    App.state.passCalculation.allFoundPasses = [...previousPasses, ...App.state.passCalculation.allFoundPasses];
					App.state.passCalculation.allFoundPasses.sort((a,b) => a.start - b.start);
					App.state.previousBestPassesLoaded = true;
					
					this.renderFilteredPasses();
				}, 50);
			},
			renderFilteredPasses() {
                const { bestPassesList, showPreviousBestPassesBtn, viewMoreContainerBestPasses } = App.elements;
                const now = new Date();
                
                let passesToConsider = App.state.passCalculation.allFoundPasses.filter(p => p.maxElevation > 50);

                if (!App.state.previousBestPassesLoaded) {
                    passesToConsider = passesToConsider.filter(p => p.start > now);
                }

                const passesToRender = this.filterPasses(passesToConsider);
                bestPassesList.innerHTML = '';

                if (passesToRender.length === 0 && !App.state.passCalculation.inProgress) {
                    bestPassesList.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg" data-lang-key="noPassesForFilter">${App.language.getTranslation('noPassesForFilter')}</p>`;
                    showPreviousBestPassesBtn.classList.add('hidden');
                    viewMoreContainerBestPasses.classList.add('hidden');
                    App.ui.hideLoadingModal();
                    return;
                }

                let currentDay = '';
                const dayOptions = { weekday: 'long', month: 'long', day: 'numeric' };
                const timeOptions = { hour: '2-digit', minute:'2-digit' };

                const today = new Date();
                const todayString = App.time.formatCityTime(today, { year: 'numeric', month: 'numeric', day: 'numeric' });

                let itemDelayIndex = 0;
                passesToRender.forEach(pass => {
                    const passDate = App.time.formatCityTime(pass.start, dayOptions).replace(',', '');
                    if (passDate !== currentDay) {
                        currentDay = passDate;
                        const header = document.createElement('h3');
                        header.className = 'pass-date-header list-item-animation';
                        header.textContent = currentDay;
                        header.style.animationDelay = `${itemDelayIndex * 30}ms`;
                        bestPassesList.appendChild(header);
                        itemDelayIndex++;
                    }

                    const passInfo = { satName: pass.satName, start: pass.start.getTime(), end: pass.end.getTime(), maxElevation: pass.maxElevation, tle: pass.tle };
                    const passInfoString = JSON.stringify(passInfo).replace(/"/g, '&quot;');
                    
                    const passCard = document.createElement('div');
                    const passDateString = App.time.formatCityTime(pass.start, { year: 'numeric', month: 'numeric', day: 'numeric' });
                    const isToday = passDateString === todayString;

                    passCard.className = `pass-card pass-card-clickable best-pass-item list-item-animation ${pass.isPast ? 'previous-pass' : ''} ${isToday ? 'pass-card-today' : ''}`;
                    passCard.dataset.timestamp = pass.start.getTime();
                    passCard.dataset.tle = pass.tle;
                    passCard.style.animationDelay = `${itemDelayIndex * 30}ms`;
                    itemDelayIndex++;
                    
                    passCard.innerHTML = `
                        <div class="flex-grow">
                            <span class="font-bold text-base block text-white">${pass.satName}</span>
                            <span class="font-mono text-sm text-text-secondary">${App.time.formatCityTime(pass.start, timeOptions)} - ${App.time.formatCityTime(pass.end, timeOptions)}</span>
                        </div>
                        <div class="flex items-center flex-shrink-0">
                            <div class="mr-4 text-center">
								<div class="pass-elevation-label" style="color: ${this.getElevationColor(pass.maxElevation)};">ELEV.<br>MÁX.</div>
								<div class="font-bold text-lg" style="color: ${this.getElevationColor(pass.maxElevation)};">
									${pass.maxElevation.toFixed(0)}°
								</div>
							</div>
                            <div class="notification-pill">
                                <button class="notification-btn" data-lang-key="notifyMe" title="${App.language.getTranslation('notifyMe').title}" data-pass-info='${passInfoString}'>
                                    <i class="fa-regular fa-bell text-lg"></i>
                                </button>
                                <button class="add-to-calendar-btn" data-lang-key="addToCalendar" title="${App.language.getTranslation('addToCalendar').title}" data-pass-info='${passInfoString}'>
                                    <i class="fa-regular fa-calendar-plus text-lg"></i>
                                </button>
                            </div>
                        </div>`;
                    
                    const passId = App.notifications._getPassId(pass);
                    const scheduled = App.notifications._loadScheduled();
                    if (scheduled[passId] && scheduled[passId].length > 0) {
                        const notifyBtn = passCard.querySelector('.notification-btn');
                        if (notifyBtn) {
                            const icon = notifyBtn.querySelector('i');
                            if (icon) icon.classList.replace('fa-regular', 'fa-solid');
                            notifyBtn.style.color = 'var(--color-success)';
                        }
                    }
                    
                    bestPassesList.appendChild(passCard);
                });
                
                bestPassesList.querySelectorAll('.best-pass-item').forEach(item => {
                    item.addEventListener('click', (e) => {
                        if (!e.target.closest('.notification-pill button')) {
                            this.handleBestPassClick(e.currentTarget);
                        }
                    });
                });
                bestPassesList.querySelectorAll('.add-to-calendar-btn').forEach(button => {
                    button.addEventListener('click', (e) => this.handleAddToCalendarClick(e));
                });
                bestPassesList.querySelectorAll('.notification-btn').forEach(button => {
                    button.addEventListener('click', (e) => App.notifications.openModal(e.currentTarget.dataset.passInfo, e.currentTarget));
                });

                App.ui.hideLoadingModal();
            },
            startPassCalculation(satsToCalculate, renderTarget) {
                this.stopPassCalculation();
            
                const { passCalculation, currentBestPassesSource } = App.state;
                passCalculation.inProgress = true;
                passCalculation.controller = new AbortController();
                passCalculation.daysCalculated = 0;
                passCalculation.firstPassFound = false;
                passCalculation.startDate = new Date();
                passCalculation.satsToCalculate = satsToCalculate;
                passCalculation.renderTarget = renderTarget;
                passCalculation.allFoundPasses = [];

                if (renderTarget === 'bestPasses') {
                    // Si la fuente es 'todos', calcula de a 1 día. Si no, usa el valor por defecto más grande.
                    passCalculation.daysPerBatch = currentBestPassesSource === 'all' ? 1 : 15;
                } else {
                    // Para el modal de pases de un satélite específico, usa el tamaño de lote normal.
                    passCalculation.daysPerBatch = App.config.passCalculationBatchSize;
                }
            
                const listContainer = renderTarget === 'bestPasses' ? App.elements.bestPassesList : App.elements.resultsContainer;
                listContainer.innerHTML = '';
            
                this.calculateNextPassBatch();
            },
            
            async calculateNextPassBatch() {
                const { passCalculation } = App.state;
                const { viewMoreBtnBestPasses, viewMoreBtnModal } = App.elements;
                const viewMoreBtn = passCalculation.renderTarget === 'bestPasses' ? viewMoreBtnBestPasses : viewMoreBtnModal;
            
                if (viewMoreBtn && viewMoreBtn.disabled) return; 

                // Cambia el texto del botón "Ver más" a "Calculando..." en lugar de mostrar el modal grande
                if (viewMoreBtn) {
                    viewMoreBtn.disabled = true;
                    viewMoreBtn.textContent = App.language.getTranslation('calculating');
                }
            
                // El cálculo se envuelve en un setTimeout para no bloquear la UI
                setTimeout(async () => {
                    if (passCalculation.controller.signal.aborted) {
                        if (viewMoreBtn) {
                            viewMoreBtn.disabled = false;
                            viewMoreBtn.textContent = App.language.getTranslation('viewMoreButton');
                        }
                        return;
                    }

                    const batchSize = passCalculation.daysPerBatch || App.config.passCalculationBatchSize;
                    const startDate = new Date(passCalculation.startDate);
                    startDate.setDate(startDate.getDate() + passCalculation.daysCalculated);
                
                    const satrecs = passCalculation.satsToCalculate.map(sat => {
                        const parsed = App.satellites.parseTLE(sat.tle);
                        if (!parsed[0]) return null;
                        return { name: sat.name, satrec: satellite.twoline2satrec(parsed[0].line1, parsed[0].line2), tle: sat.tle };
                    }).filter(Boolean);
                
                    let passesInBatch = [];
                    for (let i = 0; i < batchSize; i++) {
                        if (passCalculation.controller.signal.aborted) break;
                
                        const currentDate = new Date(startDate);
                        currentDate.setDate(currentDate.getDate() + i);
                
                        for (const sat of satrecs) {
                            const passes = this.calculateVisiblePasses(sat, App.state.observerCoords, { days: 1, startDate: currentDate });
                            const passesWithInfo = passes.map(p => ({ ...p, satName: sat.name, tle: sat.tle }));
                            passesInBatch.push(...passesWithInfo);
                        }
                    }

                    if (passCalculation.controller.signal.aborted) {
                        return;
                    }
                
                    passCalculation.daysCalculated += batchSize;
                    
                    if (passesInBatch.length > 0) {
                        if (!passCalculation.firstPassFound) {
                            passCalculation.firstPassFound = true;
                        }
                        passesInBatch.sort((a, b) => a.start - b.start);
                        passCalculation.allFoundPasses.push(...passesInBatch);
                        passCalculation.allFoundPasses.sort((a, b) => a.start - b.start);
                    }
                
                    if (passCalculation.daysCalculated >= App.config.passCalculationMaxDays) {
                        passCalculation.inProgress = false;
                    }

                    // La función de renderizado se encarga de ocultar el modal principal la primera vez
                    if (passCalculation.renderTarget === 'bestPasses') {
                        this.renderFilteredPasses();
                    } else {
                        this.displayPasses(passCalculation.allFoundPasses, false);
                    }
                
                    this.updateViewMoreButton();
                
                    // Se elimina la llamada recursiva automática para que el usuario controle la carga con el botón
                }, 50); // Un pequeño delay para que la UI se actualice
            },
            
            updateViewMoreButton() {
                const { passCalculation } = App.state;
                const container = passCalculation.renderTarget === 'bestPasses' ? App.elements.viewMoreContainerBestPasses : App.elements.viewMoreContainerModal;
                const button = passCalculation.renderTarget === 'bestPasses' ? App.elements.viewMoreBtnBestPasses : App.elements.viewMoreBtnModal;
                const list = passCalculation.renderTarget === 'bestPasses' ? App.elements.bestPassesList : App.elements.resultsContainer;

                const spinner = list.querySelector('.calculating-spinner');
                if (spinner) spinner.remove();

                if (passCalculation.inProgress) {
                    container.classList.remove('hidden');
                    button.disabled = false;
                    button.textContent = App.language.getTranslation('viewMoreButton');
                } else {
                    container.classList.add('hidden');
                    if (!passCalculation.firstPassFound) {
                        list.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg" data-lang-key="noPassesForFilter">${App.language.getTranslation('noPassesForFilter')}</p>`;
                    }
                    // *** MODIFICACIÓN INICIA ***
                    if (passCalculation.renderTarget === 'bestPasses' && App.state.observerCoords) {
                        const source = App.state.currentBestPassesSource;
                        const cacheKey = `best_passes_cache_${source}_${App.state.observerCoords[0]}_${App.state.observerCoords[1]}`;
                        const dataToCache = {
                            timestamp: Date.now(),
                            passes: passCalculation.allFoundPasses
                        };
                        try {
                            sessionStorage.setItem(cacheKey, JSON.stringify(dataToCache));
                            console.log(`Resultados para '${source}' guardados en la caché.`);
                        } catch(e) {
                            console.error("Error al guardar los pases en caché:", e);
                        }
                    }
                    // *** MODIFICACIÓN TERMINA ***
                }
            },
            
            stopPassCalculation() {
                if (App.state.passCalculation.inProgress) {
                    App.state.passCalculation.controller.abort();
                    App.state.passCalculation.inProgress = false;
                    App.ui.hideLoadingModal();
                    console.log("Cálculo de pases detenido.");
                }
            },
            
			handleBestPassClick(element) {
				const tle = element.dataset.tle;
				const timestamp = element.dataset.timestamp;
				if (!tle || !timestamp) { console.error("Falta TLE o timestamp para el clic en el mejor paso"); return; }
				App.playSound('success', 'A4');
				App.state.pendingPassJumpTimestamp = timestamp;
				localStorage.setItem(App.config.lastSatStorageKey, tle);
				App.elements.tleInput.value = tle;
				App.satellites.handleTleLoad(true);
				App.navigation.go('app-container');
			},
			toICSDate(date) {
				const pad = num => (num < 10 ? '0' : '') + num;
				return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
			},
			handleAddToCalendarClick(e) {
				e.stopPropagation();
				App.playSound('success', 'C5');

				const passData = JSON.parse(e.currentTarget.dataset.passInfo);
				const startDate = new Date(passData.start);
				const endDate = new Date(passData.end);
				const locationName = App.elements.bestPassesLocationInput.value || App.language.getTranslation('observerLocation');
				
				const summary = App.language.getTranslation('calendarSummary').replace('{name}', passData.satName);
				const description = App.language.getTranslation('calendarDesc').replace('{name}', passData.satName).replace('{elevation}', passData.maxElevation.toFixed(0));

				const icsContent = [
					'BEGIN:VCALENDAR',
					'VERSION:2.0',
					'BEGIN:VEVENT',
					`UID:${startDate.getTime()}@satelitesarg.com`,
					`DTSTAMP:${this.toICSDate(new Date())}`,
					`DTSTART:${this.toICSDate(startDate)}`,
					`DTEND:${this.toICSDate(endDate)}`,
					`SUMMARY:${summary}`,
					`DESCRIPTION:${description}`,
					`LOCATION:${locationName}`,
					'END:VEVENT',
					'END:VCALENDAR'
				].join('\r\n');

				const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				const fileName = App.language.getTranslation('calendarFilename').replace('{name}', passData.satName.replace(/\s+/g, '_'));
				link.setAttribute('download', fileName);
				document.body.appendChild(link);
				link.click();
				document.body.removeChild(link);
				URL.revokeObjectURL(url);
			},
			getSunEci(date) { 
				const jday = satellite.jday(new Date(date));
				const mjd = jday - 2400000.5;
				const jd2000 = mjd - 51544.5; 
				const MA = (357.5291 + 0.98560028 * jd2000) % 360;
				const MArad = satellite.degreesToRadians(MA); 
				const L = (280.459 + 0.98564736 * jd2000) % 360; 
				const C = 1.915 * Math.sin(MArad) + 0.020 * Math.sin(2 * MArad); 
				const lambda = satellite.degreesToRadians((L + C) % 360);
				const epsilon = satellite.degreesToRadians(23.4393 - 3.563E-7 * jd2000); 
				const R_AU = 1.00014 - 0.01671 * Math.cos(MArad) - 0.00014 * Math.cos(2 * MArad);
				const R_km = R_AU * 149597870.7; 
				return { x: R_km * Math.cos(lambda), y: R_km * Math.sin(lambda) * Math.cos(epsilon), z: R_km * Math.sin(lambda) * Math.sin(epsilon) }; 
			},
			isSatIlluminated(satEci, date) { const sunEci = this.getSunEci(date); const dotProduct = (satEci.x * sunEci.x) + (satEci.y * sunEci.y) + (satEci.z * sunEci.z); if (dotProduct > 0) return true; const satMagSq = (satEci.x ** 2) + (satEci.y ** 2) + (satEci.z ** 2), sunMagSq = (sunEci.x ** 2) + (sunEci.y ** 2) + (sunEci.z ** 2); return (satMagSq - (dotProduct ** 2 / sunMagSq)) > (6378.137 ** 2); },
			
			calculateSkyPath(sat, referenceTime, coords) {
				const skyPath = [];
				if (!sat || !sat.satrec || !coords) return skyPath;

				const observerGd = { latitude: satellite.degreesToRadians(coords[0]), longitude: satellite.degreesToRadians(coords[1]), height: 0.1 };
				const loopStart = new Date(referenceTime.getTime() - (30) * 60000);

				for (let i = 0; i < (120 * 60) / 5; i++) {
					const time = new Date(loopStart.getTime() + i * 5 * 1000);
					try {
						const posVel = satellite.propagate(sat.satrec, new Date(time));
						const gmst = satellite.gstime(new Date(time));
						const posEcf = satellite.eciToEcf(posVel.position, gmst);
						const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
						const elevation = satellite.radiansToDegrees(lookAngles.elevation);

						if (elevation > 0) {
							const isObserverDark = this._isObserverInDarkness(time, coords);
							const isSatInSunlight = this.isSatIlluminated(posVel.position, time);
							const isVisibleNow = isObserverDark && isSatInSunlight && elevation > 10;
							
							skyPath.push({
								az: satellite.radiansToDegrees(lookAngles.azimuth),
								el: elevation,
								isVisible: isVisibleNow,
								time: time
							});
						}
					} catch (e) {
						continue;
					}
				}
				return skyPath;
			},
			findNextVisiblePass() {
				const sat = App.state.trackedSatellites[0];
				const coords = App.state.observerCoords;
				if (!sat || !coords) {
					App.state.nextVisiblePass = null;
					return;
				}
				const passes = this.calculateVisiblePasses(sat, coords, { days: 2, direction: 'future' });
				if (passes.length > 0) {
					App.state.nextVisiblePass = { start: passes[0].start, end: passes[0].end };
				} else {
					App.state.nextVisiblePass = null;
				}
			},
			drawPassTrajectory(sat, referenceTime, coords) {
				const { map } = App.state;
				if (!map || !sat.satrec) return;
				
				App.state.currentSkyPath = this.calculateSkyPath(sat, referenceTime, coords);
				
				const oldOrbitLayers = sat.orbitLayers;
				sat.orbitLayers = [];
				const oldTimeLabelLayers = sat.timeLabelLayers;
				sat.timeLabelLayers = [];

				const observerGd = { latitude: satellite.degreesToRadians(coords[0]), longitude: satellite.degreesToRadians(coords[1]), height: 0.1 };
				const masterPath = [], loopStart = new Date(referenceTime.getTime() - (30) * 60000);
				let lastLabeledMinute = -1;
				let lastLon = null;

				for (let i = 0; i < (90 * 60) / 10; i++) {
					const time = new Date(loopStart.getTime() + i * 10 * 1000);
					try {
						const posVel = satellite.propagate(sat.satrec, new Date(time));
						const gmst = satellite.gstime(new Date(time));
						const posEcf = satellite.eciToEcf(posVel.position, gmst);
						const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
						const elevation = satellite.radiansToDegrees(lookAngles.elevation);
						if (elevation < 0) continue;
						
						const posGd = satellite.eciToGeodetic(posVel.position, gmst);
						const isObserverDark = this._isObserverInDarkness(time, coords);
						const lat = satellite.radiansToDegrees(posGd.latitude);
						let lon = satellite.radiansToDegrees(posGd.longitude);

						if (lastLon !== null) {
							while (lon - lastLon > 180) lon -= 360;
							while (lon - lastLon < -180) lon += 360;
						}
						lastLon = lon;

						masterPath.push({ lat, lon, isVisible: isObserverDark && this.isSatIlluminated(posVel.position, time) && elevation > 10 });
						
						const localTimeForLabel = parseInt(App.time.formatCityTime(time, { minute: '2-digit'}), 10);
						
						if (localTimeForLabel !== lastLabeledMinute && time.getSeconds() < 10) {
							const labelTime = App.time.formatCityTime(time, { hour: '2-digit', minute: '2-digit' });
							const timeLabelIcon = L.divIcon({
								className: 'trajectory-time-label',
								html: `<div>${labelTime}</div>`,
								iconSize: [40, 20],
								iconAnchor: [20, 25]
							});
							
							const offsets = [0, 360, -360, 720, -720];
							offsets.forEach(offset => {
								const timeLabelMarker = L.marker([lat, lon + offset], { icon: timeLabelIcon, minute: localTimeForLabel });
								sat.timeLabelLayers.push(timeLabelMarker);
							});
							lastLabeledMinute = localTimeForLabel;
						}

					} catch (e) { continue; }
				}
				if (masterPath.length < 2) return [];
				
				const segments = [];
				let currentSegment = { path: [], isVisible: masterPath[0].isVisible };
				
				masterPath.forEach(point => {
					if (point.isVisible !== currentSegment.isVisible) {
						segments.push(currentSegment);
						currentSegment = { path: [currentSegment.path[currentSegment.path.length - 1]], isVisible: point.isVisible };
					}
					currentSegment.path.push([point.lat, point.lon]);
				});
				segments.push(currentSegment);

				const visibleTrajectories = [];
				const offsets = [0, 360, -360, 720, -720];

				segments.forEach(segment => {
					if (segment.path.length < 2) return;
					
					if(segment.isVisible) visibleTrajectories.push(segment.path);

					const options = {
						className: segment.isVisible ? 'orbit-path' : 'orbit-path-shadow',
						pane: 'trajectoryPane'
					};
					
					offsets.forEach(offset => {
						const offsetPath = segment.path.map(p => [p[0], p[1] + offset]);
						sat.orbitLayers.push(L.polyline(offsetPath, options).addTo(map));
					});
				});

				setTimeout(() => {
					if (oldOrbitLayers) oldOrbitLayers.forEach(layer => map.removeLayer(layer));
					if (oldTimeLabelLayers) oldTimeLabelLayers.forEach(layer => map.removeLayer(layer));
				}, 0);

				return visibleTrajectories;
			},
			updateTrajectoryLabelsVisibility() {
				const { map, trackedSatellites } = App.state;
				if (!map || trackedSatellites.length === 0) return;
				const sat = trackedSatellites[0];
				const allLabels = sat.timeLabelLayers;
				if (!allLabels || allLabels.length === 0) return;

				const zoom = map.getZoom();
				let interval = 1;
				if (zoom < 3) { interval = 15; }
				else if (zoom < 3.5) { interval = 5; }
				else if (zoom < 4.5) { interval = 2; }

				const uniqueMinutes = new Map();
				allLabels.forEach(label => {
					if (!uniqueMinutes.has(label.options.minute)) {
						uniqueMinutes.set(label.options.minute, []);
					}
					uniqueMinutes.get(label.options.minute).push(label);
				});

				const sortedMinutes = Array.from(uniqueMinutes.keys()).sort((a,b) => a-b);
				
				sortedMinutes.forEach((minute, index) => {
					const labelsForMinute = uniqueMinutes.get(minute);
					const shouldBeVisible = index % interval === 0;

					labelsForMinute.forEach(label => {
						const el = label.getElement();
						if (shouldBeVisible) {
							if (!map.hasLayer(label)) label.addTo(map);
							setTimeout(() => {
								if (el) el.classList.add('visible');
							}, 10);
						} else {
							if (map.hasLayer(label)) {
								if (el) {
									el.classList.remove('visible');
									setTimeout(() => {
										if (map.hasLayer(label) && !el.classList.contains('visible')) {
											label.remove();
										}
									}, 300);
								} else {
									label.remove();
								}
							}
						}
					});
				});
			},
			jumpToPassTime(timestamp, tle = null) {
				if (tle && (App.state.isAllSatellitesMode || App.state.trackedSatellites.length > 1)) {
					App.state.isAllSatellitesMode = false;
					localStorage.setItem(App.config.lastSatStorageKey, tle);
					App.elements.tleInput.value = tle;
					App.satellites.handleTleLoad(true);
					App.satellites.handleTracking();
				}
			
				const time = parseInt(timestamp, 10); if (isNaN(time)) return; 
				App.time.startTimeTravel(); App.state.isPassViewActive = true; App.state.passTrajectoryDrawn = false; App.state.currentTime = new Date(time); this.clearVisibilityBands();
				
				App.time.updateMapForCurrentTime();
				
				if(location.hash === '#modal') history.back();
				App.elements.mainControlPanel.classList.remove('expanded'); 
				App.elements.timeControlPanel.classList.remove('visible');
				
				document.body.classList.remove('time-controls-active');

				if (App.state.observerCoords) {
					App.state.map.flyTo(App.state.observerCoords, 4, { duration: 0.8 });
				}
				
				const date = new Date(time);
				App.elements.predictionDateDisplay.textContent = App.time.formatCityTime(date, { day: 'numeric', month: 'long' });
				App.elements.predictionDateDisplay.classList.remove('hidden');

				App.elements.timeControlHandle.classList.add('hidden');
				App.location.applySavedLocationToMap();
			},
			getGroundRadiusForElevation(elevationDegrees, altitudeKm) { const R = 6371; const elevRads = satellite.degreesToRadians(elevationDegrees); const beta = Math.asin((R / (R + altitudeKm)) * Math.cos(elevRads)); const phi = Math.PI / 2 - elevRads - beta; return R * phi; },
			
			drawVisibilityBands(trajectories, sat) {
				if (!trajectories || trajectories.length === 0 || !sat) return;
				this.clearVisibilityBands();
				App.state.visibilityBands.trajectory = trajectories;

				let altitude = 400;
				try {
					const midPassTime = new Date(App.state.currentTime.getTime());
					const posVel = satellite.propagate(sat.satrec, new Date(midPassTime));
					const gmst = satellite.gstime(new Date(midPassTime));
					const posGd = satellite.eciToGeodetic(posVel.position, gmst);
					altitude = posGd.height;
				} catch (e) {
					console.error("No se pudo calcular la altitud del satélite, usando valor por defecto.");
				}

				const distances = {
					periferica: this.getGroundRadiusForElevation(10, altitude),
					media: this.getGroundRadiusForElevation(30, altitude),
					optima: this.getGroundRadiusForElevation(60, altitude),
				};

				const isSatelliteView = App.elements.appContainer.classList.contains('satellite-view-active');
				
				const opacities = {
					periferica: isSatelliteView ? 0.45 : 0.15,
					media: isSatelliteView ? 0.50 : 0.20,
					optima: isSatelliteView ? 0.55 : 0.25,
				};
				const colors = {
					periferica: 'rgb(248, 81, 73)',
					media: 'rgb(247, 181, 48)',
					optima: 'rgb(57, 211, 83)',
				};

				const createBandRing = (trajectory, dist) => {
					const boundaries = { left: [], right: [] };
					for (let i = 0; i < trajectory.length; i++) {
						const p1 = trajectory[i];
						let bearing;
						if (i === 0 && trajectory.length > 1) { bearing = calculateBearing(p1, trajectory[i + 1]); } 
						else if (i === trajectory.length - 1 && trajectory.length > 1) { bearing = calculateBearing(trajectory[i - 1], p1); } 
						else if (trajectory.length > 1) { const bearingFromPrev = calculateBearing(trajectory[i - 1], p1); const bearingToNext = calculateBearing(p1, trajectory[i + 1]); let angleDiff = bearingToNext - bearingFromPrev; if (angleDiff > 180) angleDiff -= 360; if (angleDiff < -180) angleDiff += 360; bearing = bearingFromPrev + angleDiff / 2; }
						else { bearing = 0; }
						boundaries.right.push(calculateDestinationPoint(p1[0], p1[1], bearing + 90, dist));
						boundaries.left.push(calculateDestinationPoint(p1[0], p1[1], bearing - 90, dist));
					}
					const path = []; path.push(...boundaries.right);
					if (trajectory.length > 1) {
						const endPoint = trajectory[trajectory.length - 1]; const endBearing = calculateBearing(trajectory[trajectory.length - 2], trajectory[trajectory.length - 1]);
						for (let angle = endBearing + 90; angle >= endBearing - 90; angle -= 10) { path.push(calculateDestinationPoint(endPoint[0], endPoint[1], angle, dist)); } path.push(...boundaries.left.reverse());
						const startPoint = trajectory[0]; const startBearing = calculateBearing(trajectory[0], trajectory[1]);
						for (let angle = startBearing - 90; angle >= startBearing - 270; angle -= 10) { path.push(calculateDestinationPoint(startPoint[0], startPoint[1], angle, dist)); }
					}
					return path;
				};

				const offsets = [0, 360, -360, 720, -720];

				trajectories.forEach(trajectory => {
					if (trajectory.length < 2) return;
					
					offsets.forEach(offset => {
						const offsetTrajectory = trajectory.map(p => [p[0], p[1] + offset]);

						const optimaRing = createBandRing(offsetTrajectory, distances.optima);
						const optimaPolygon = L.polygon(optimaRing, { fillColor: colors.optima, fillOpacity: 0, weight: 0, className: 'visibility-band', pane: 'visibilityBandsPane' });
						optimaPolygon.targetOpacity = opacities.optima;
						App.state.visibilityBands.layers.push(optimaPolygon);
						
						const mediaOuterRing = createBandRing(offsetTrajectory, distances.media);
						const mediaPolygon = L.polygon([mediaOuterRing, optimaRing], { fillColor: colors.media, fillOpacity: 0, weight: 0, className: 'visibility-band', pane: 'visibilityBandsPane' });
						mediaPolygon.targetOpacity = opacities.media;
						App.state.visibilityBands.layers.push(mediaPolygon);

						const gradientPortion = 0.35;
						const solidEndDist = distances.periferica - (distances.periferica - distances.media) * gradientPortion;
						
						const redOuterSolidRing = createBandRing(offsetTrajectory, solidEndDist);
						const redInnerSolidRing = createBandRing(offsetTrajectory, distances.media);
						const solidRedPolygon = L.polygon([redOuterSolidRing, redInnerSolidRing], { fillColor: colors.periferica, fillOpacity: 0, weight: 0, className: 'visibility-band', pane: 'visibilityBandsPane' });
						solidRedPolygon.targetOpacity = opacities.periferica;
						App.state.visibilityBands.layers.push(solidRedPolygon);

						const gradientStartDist = solidEndDist;
						const numSteps = 15;
						const gradientWidth = distances.periferica - gradientStartDist;

						for (let i = 0; i < numSteps; i++) {
							const innerRingDist = gradientStartDist + (i * gradientWidth / numSteps);
							const outerRingDist = gradientStartDist + ((i + 1) * gradientWidth / numSteps);
							const opacity = opacities.periferica * (1 - (i / (numSteps -1) ));

							const outerRingPath = createBandRing(offsetTrajectory, outerRingDist);
							const innerRingPath = createBandRing(offsetTrajectory, innerRingDist);

							const polygon = L.polygon([outerRingPath, innerRingPath], { fillColor: colors.periferica, fillOpacity: 0, weight: 0, className: 'visibility-band', pane: 'visibilityBandsPane' });
							polygon.targetOpacity = opacity; 
							App.state.visibilityBands.layers.push(polygon);
						}
					});
				});
			},

			toggleVisibilityBands(playSound = true) {
				if (playSound) App.playSound('uiClick', 'F4');
				const { visibilityBands, map } = App.state;
				const button = App.elements.toggleVisibilityBandsBtn;
				const legend = App.elements.visibilityLegend;
				visibilityBands.visible = !visibilityBands.visible;

				if (visibilityBands.visible) {
					visibilityBands.layers.forEach(layer => {
						if (!map.hasLayer(layer)) {
							layer.setStyle({ fillOpacity: 0 });
							layer.addTo(map);
						}
					});
					setTimeout(() => {
						visibilityBands.layers.forEach(layer => {
							const targetOpacity = layer.targetOpacity !== undefined ? layer.targetOpacity : 0.2;
							layer.setStyle({ fillOpacity: targetOpacity });
						});
					}, 10);
					button.classList.add('active');
					legend.classList.remove('hidden');
				} else {
					visibilityBands.layers.forEach(layer => layer.setStyle({ fillOpacity: 0 }));
					setTimeout(() => {
						if (!visibilityBands.visible) {
							visibilityBands.layers.forEach(layer => {
								if (map.hasLayer(layer)) map.removeLayer(layer);
							}
);
						}
					}, 400);
					button.classList.remove('active');
					legend.classList.add('hidden');
				}
			},

			clearVisibilityBands() {
				const { visibilityBands, map } = App.state;
				if (visibilityBands.layers.length > 0) {
					visibilityBands.layers.forEach(layer => {
						if (map.hasLayer(layer)) {
							map.removeLayer(layer);
						}
					});
				}
				visibilityBands.layers = [];
				visibilityBands.trajectory = [];
				App.radar.clearTrajectory();

				App.elements.toggleVisibilityBandsBtn.classList.add('hidden');
				App.elements.visibilityControls.classList.add('hidden');
				App.elements.visibilityLegend.classList.add('hidden');
				App.elements.toggleVisibilityBandsBtn.classList.remove('active');
				visibilityBands.visible = false;
			}
		},
		time: {
			formatCityTime(utcDate, options) {
				const timeZone = App.state.observerTimeZone?.timeZone;
				const lang = App.settings.current.language === 'en' ? 'en-US' : 'es-AR';
				const defaultOptions = { hour12: false, timeZone: timeZone || 'UTC' };
				const finalOptions = { ...defaultOptions, ...options };

				try {
					return new Intl.DateTimeFormat(lang, finalOptions).format(utcDate);
				} catch (e) {
					console.error("Error formatting date:", e);
					return utcDate.toUTCString();
				}
			},
			updateClockPill() {
				const { utcTimeDisplay } = App.elements;
				if (!utcTimeDisplay) return;
			
				if (!App.state.observerCoords) {
					utcTimeDisplay.textContent = '--:--:--';
					return;
				}
			
				const localTime = this.formatCityTime(App.state.currentTime, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
				utcTimeDisplay.textContent = `${localTime}`;
			},
			updateSpecialOrbitMode() {
				const { nextVisiblePass } = App.state;
				let shouldBeActive = false;
				if (nextVisiblePass) {
					const now = App.state.currentTime.getTime();
					const tenMinutesBefore = nextVisiblePass.start.getTime() - (10 * 60 * 1000); 
					const twoMinutesAfter = nextVisiblePass.end.getTime() + (2 * 60 * 1000);   
					shouldBeActive = now >= tenMinutesBefore && now <= twoMinutesAfter;
				}

				if (shouldBeActive !== App.state.isSpecialOrbitModeActive) {
					App.state.isSpecialOrbitModeActive = shouldBeActive;
					return true;
				}
				return false;
			},
			updateMapForCurrentTime(options = {}) {
				const { forceOrbitRedraw = false } = options;

				if (App.state.isNearbyModeActive) {
					App.nearbyMode.update();
					this.updateTimeUI();
					this.updateClockPill();
					return;
				}

				App.nightOverlay.update();
			
				App.satellites.updatePositions();
			
				if (App.state.isPassViewActive && !App.state.passTrajectoryDrawn) {
					const sat = App.state.trackedSatellites[0];
					if (sat && App.state.observerCoords) {
						const visibleSegments = App.prediction.drawPassTrajectory(sat, App.state.currentTime, App.state.observerCoords);
						App.prediction.updateTrajectoryLabelsVisibility();
			
						if (visibleSegments && visibleSegments.length > 0) {
							App.prediction.drawVisibilityBands(visibleSegments, sat);
							App.elements.visibilityControls.classList.remove('hidden');
							App.elements.toggleVisibilityBandsBtn.classList.remove('hidden');
						}
						App.state.passTrajectoryDrawn = true;
					}
				} 
				else if (!App.state.isPassViewActive) {
					if ((App.state.trackedSatellites.length <= 1 || forceOrbitRedraw) && !App.state.isAllSatellitesMode) {
						App.satellites.drawOrbits();
					}
				}

				if (App.state.isAllSatellitesMode && App.state.selectedSatForOrbit) {
					const satIndex = App.state.trackedSatellites.findIndex(s => s.tle === App.state.selectedSatForOrbit.tle);
					if (satIndex !== -1) {
						App.satellites.drawSingleOrbit(satIndex);
					}
				}
			
				if (App.radar.isSensorActive) {
					App.radar.drawRadarContent();
				}
			
				this.updateTimeUI();
				this.updateClockPill();
			},
			startRealTimeUpdates() {
				this.stopRealTimeUpdates();
				App.state.realTimeInterval = setInterval(() => {
					if (App.state.isTimeTraveling) return;
					App.state.currentTime = new Date();
					App.satellites.updatePositions();
					this.updateClockPill();
			
					if (App.state.trackedSatellites.length === 1) {
						if (App.state.nextVisiblePass && App.state.currentTime > new Date(App.state.nextVisiblePass.end.getTime() + (2 * 60 * 1000))) {
							App.prediction.findNextVisiblePass();
						}
						this.updateSpecialOrbitMode();
					}
				}, 1000);
			
				App.state.staggeredUpdateInterval = setInterval(() => {
					if (App.state.isTimeTraveling) return;

					if (App.state.isAllSatellitesMode) {
						if (App.state.selectedSatForOrbit) {
							const satIndex = App.state.trackedSatellites.findIndex(s => s.tle === App.state.selectedSatForOrbit.tle);
							if (satIndex !== -1) {
								App.satellites.drawSingleOrbit(satIndex);
							}
						}
						return;
					};
			
					const numSats = App.state.trackedSatellites.length;
					if (numSats > 1) {
						const satIndex = App.state.nextSatToUpdateIndex;
						App.satellites.drawSingleOrbit(satIndex);
						App.state.nextSatToUpdateIndex = (satIndex + 1) % numSats;
					} else if (numSats === 1) {
						App.satellites.drawOrbits();
					}
				}, 10000);
			},

			stopRealTimeUpdates() { 
				clearInterval(App.state.realTimeInterval); 
				App.state.realTimeInterval = null; 
				clearInterval(App.state.staggeredUpdateInterval);
				App.state.staggeredUpdateInterval = null;
			},

			updateResetTimeButtonState() {
				const isTimeTraveling = App.state.isTimeTraveling;
				const resetTimeBtn = App.elements.resetTimeBtn;

				if (resetTimeBtn) {
					resetTimeBtn.disabled = !isTimeTraveling;
					resetTimeBtn.classList.toggle('is-realtime', !isTimeTraveling);
				}
			},

			startTimeTravel() {
				if (!App.state.isTimeTraveling) {
					App.state.isTimeTraveling = true;
					this.stopRealTimeUpdates();
					App.elements.toggleTimeControlBtn.classList.add('time-traveling-active');
					this.updateResetTimeButtonState(); // Update button state
				}
			},

			stopTimeTravel() {
				if (App.state.isTimeTraveling) {
					App.state.isTimeTraveling = false;
					App.state.isPassViewActive = false;
					App.state.passTrajectoryDrawn = false;
					App.elements.toggleTimeControlBtn.classList.remove('time-traveling-active');
					this.updateResetTimeButtonState();
					App.prediction.clearVisibilityBands();
					App.elements.predictionDateDisplay.classList.add('hidden');
				}
				App.state.currentTime = new Date();
				this.updateTimeUI();
				// Se llama a la función principal de actualización para refrescar todo (sombra, órbitas, etc.)
				this.updateMapForCurrentTime({ forceOrbitRedraw: true }); 
				this.startRealTimeUpdates();
			},

			adjustTime(direction) { 
				this.startTimeTravel(); 
				const stepMillis = App.config.timeSteps[App.state.timeStepIndex].value; 
				App.state.currentTime.setTime(App.state.currentTime.getTime() + (stepMillis * direction)); 
				this.updateSpecialOrbitMode();
				this.updateMapForCurrentTime({ forceOrbitRedraw: true });
			},
			
			setTimeFromInputs() {
				this.startTimeTravel();
				const { dateInput, timeInput } = App.elements;
				if (dateInput.value && timeInput.value) {
					const dateTimeString = `${dateInput.value}T${timeInput.value}`;
					const tz = App.state.observerTimeZone?.timeZone;
					if (tz) {
						let approxUtc = new Date(dateTimeString + 'Z');
						let offsetStr = App.getUtcOffsetForDate(tz, approxUtc);
						let fullStr = `${dateTimeString}${offsetStr}`;
						let parsed = new Date(fullStr);
						let newOffsetStr = App.getUtcOffsetForDate(tz, parsed);
						if (newOffsetStr !== offsetStr) {
							fullStr = `${dateTimeString}${newOffsetStr}`;
							parsed = new Date(fullStr);
						}
						App.state.currentTime = parsed;
					} else {
						App.state.currentTime = new Date(dateTimeString + 'Z');
					}
					this.updateSpecialOrbitMode();
					this.updateMapForCurrentTime({ forceOrbitRedraw: true });
				}
			},
			
			setTimeFromSlider() {
				this.startTimeTravel();

				const totalMinutes = parseInt(App.elements.timelineSlider.value, 10);
				const hours = Math.floor(totalMinutes / 60);
				const minutes = totalMinutes % 60;
				const pad = (num) => String(num).padStart(2, '0');
				const timePart = `${pad(hours)}:${pad(minutes)}`;
				
				const { dateInput } = App.elements;
				const dateTimeString = `${dateInput.value}T${timePart}`;
				
				const tz = App.state.observerTimeZone?.timeZone;
				if (tz) {
					let approxUtc = new Date(dateTimeString + 'Z');
					let offsetStr = App.getUtcOffsetForDate(tz, approxUtc);
					let fullStr = `${dateTimeString}${offsetStr}`;
					let parsed = new Date(fullStr);
					let newOffsetStr = App.getUtcOffsetForDate(tz, parsed);
					if (newOffsetStr !== offsetStr) {
						fullStr = `${dateTimeString}${newOffsetStr}`;
						parsed = new Date(fullStr);
					}
					App.state.currentTime = parsed;
				} else {
					App.state.currentTime = new Date(dateTimeString + 'Z');
				}

				this.updateSpecialOrbitMode();
				this.updateMapForCurrentTime();
			},

			updateTimeUI() {
				if (!App.elements.dateInput || !App.elements.timeInput) return;
				if(!App.state.isTimeTraveling && !App.state.mapInitialized) return;

				const timeZone = App.state.observerTimeZone?.timeZone;

				const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: timeZone || 'UTC' }).format(App.state.currentTime);
				const timeStr = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(App.state.currentTime);

				App.elements.dateInput.value = dateStr;
				App.elements.timeInput.value = timeStr;

				if (App.elements.dateInputDisplay) {
					const lang = App.settings.current.language === 'en' ? 'en-US' : 'es-AR';
					const displayDate = new Intl.DateTimeFormat(lang, {
						year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timeZone || 'UTC'
					}).format(App.state.currentTime);
					App.elements.dateInputDisplay.textContent = displayDate;
				}
				if (App.elements.timeInputDisplay) {
					App.elements.timeInputDisplay.textContent = timeStr;
				}

				const [hours, minutes] = timeStr.split(':');
				App.elements.timelineSlider.value = parseInt(hours, 10) * 60 + parseInt(minutes, 10);
			}
		},
		radar: {
			activeCanvas: null, activeCtx: null, activePointer: null,
			isSensorActive: false, isInitialized: false, 
			orientationHandler: null,
			
			lastOrientationEvent: null, 
			filteredHeading: null,    
			displayHeading: 0,      
			animationFrameId: null,

			BRIGHT_OBJECTS: {
				'Sirio': { ra: 6.75, dec: -16.7, type: 'star' },
				'Canopus': { ra: 6.40, dec: -52.7, type: 'star' },
				'Alpha Centauri': { ra: 14.66, dec: -60.83, type: 'star' },
				'Alnitak': { ra: 5.69, dec: -1.94, type: 'star', belt: true },
				'Alnilam': { ra: 5.60, dec: -1.20, type: 'star', belt: true },
				'Mintaka': { ra: 5.53, dec: -0.30, type: 'star', belt: true }
			},
			
			init() {
				if (this.isInitialized) return;
				this.orientationHandler = this.handleOrientation.bind(this);
				this.updateRadarAnimation = this.updateRadarAnimation.bind(this); 
                
                const setupOverlay = (canvasElement) => {
                    if (canvasElement && canvasElement.parentElement && !canvasElement.parentElement.querySelector('.calibration-overlay')) {
                        const overlay = document.createElement('div');
                        overlay.className = 'calibration-overlay';
                        overlay.innerHTML = `<span>${App.language.getTranslation('calibrating')}...</span>`;
                        canvasElement.parentElement.appendChild(overlay);
                    }
                };
                setupOverlay(App.elements.radarCanvas);
                setupOverlay(App.elements.largeRadarCanvas);

				this.isInitialized = true;
			},
			resizeCanvas() {
				if (!this.activeCanvas) return;
				const dpr = window.devicePixelRatio || 1;
				const rect = this.activeCanvas.getBoundingClientRect();
				this.activeCanvas.width = rect.width * dpr;
				this.activeCanvas.height = rect.height * dpr;
				this.activeCtx.scale(dpr, dpr);
				this.drawRadarContent();
			},
			async requestPermissions() {
				if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
					try {
						const permissionState = await DeviceOrientationEvent.requestPermission();
						return permissionState === 'granted';
					} catch (error) {
						console.error("Error requesting device orientation permission:", error);
						return false;
					}
				}
				return true;
			},
			async calibrate() {
				App.playSound('uiClick', 'D4');
				console.log('Requesting compass permissions for calibration...');
				const hasPermission = await this.requestPermissions();
				if (hasPermission) {
					console.log('Permission granted. Compass should be active.');
				} else {
					console.warn('Permission denied during calibration attempt.');
				}
			},
			async start(canvasId, pointerId) {
				if (this.isSensorActive) this.stop();

				const canvasCamelCase = canvasId.replace(/-(\w)/g, (_, c) => c.toUpperCase());
				const pointerCamelCase = pointerId.replace(/-(\w)/g, (_, c) => c.toUpperCase());
				this.activeCanvas = App.elements[canvasCamelCase];
				this.activePointer = App.elements[pointerCamelCase];
				
				if (!this.activeCanvas || !this.activePointer) {
					console.error("Radar canvas or pointer not found:", canvasId, pointerId);
					return;
				}
				this.activeCtx = this.activeCanvas.getContext('2d');

				this.resizeCanvas();
				const hasPermission = await this.requestPermissions();
				if (hasPermission) {
					const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
                        window.addEventListener(eventName, this.orientationHandler, true);
					
                        this.isSensorActive = true;
					this.activePointer.classList.remove('hidden');
                        this.filteredHeading = null;
                        this.animationFrameId = requestAnimationFrame(this.updateRadarAnimation); 
				} else {
					console.warn("Permission for device orientation denied.");
				}

				this.drawRadarContent();
			},
			stop() {
				if (!this.isSensorActive) return;
                
                if (this.animationFrameId) {
                    cancelAnimationFrame(this.animationFrameId);
                    this.animationFrameId = null;
                }

				window.removeEventListener('deviceorientationabsolute', this.orientationHandler, true);
				window.removeEventListener('deviceorientation', this.orientationHandler, true);
				if (this.activePointer) this.activePointer.classList.add('hidden');
                if (App.elements.radarMoonIcon) App.elements.radarMoonIcon.classList.add('hidden');
                if (App.elements.largeRadarMoonIcon) App.elements.largeRadarMoonIcon.classList.add('hidden');
				this.isSensorActive = false;
				this.activeCanvas = null;
				this.activeCtx = null;
				this.activePointer = null;
                this.lastOrientationEvent = null;

                if (App.state.viewConeLayer) {
                    App.state.map.removeLayer(App.state.viewConeLayer);
                    App.state.viewConeLayer = null;
                }
			},
            showCalibrationMessage() {
                const overlays = document.querySelectorAll('.calibration-overlay');
                if (overlays.length > 0) {
                    overlays.forEach(overlay => {
						overlay.querySelector('span').textContent = App.language.getTranslation('calibrating');
                        overlay.classList.remove('is-visible');
                        void overlay.offsetWidth; 
                        overlay.classList.add('is-visible');
                        
                        setTimeout(() => {
                            overlay.classList.remove('is-visible');
                        }, 1500);
                    });
                }
            },
			handleOrientation(event) {
				if (event.alpha === null || event.beta === null || event.gamma === null) return;
                this.lastOrientationEvent = event;
			},
            updateRadarAnimation() {
                if (!this.isSensorActive) return;
                
                let elevation = 0;
                let azimuth = 0;

                if (this.lastOrientationEvent) {
                    const event = this.lastOrientationEvent;

                    const alphaRad = satellite.degreesToRadians(event.alpha);
                    const betaRad = satellite.degreesToRadians(event.beta);
                    const gammaRad = satellite.degreesToRadians(event.gamma);
                    
                    const ca = Math.cos(alphaRad); const sa = Math.sin(alphaRad);
                    const cb = Math.cos(betaRad); const sb = Math.sin(betaRad);
                    const cg = Math.cos(gammaRad); const sg = Math.sin(gammaRad);

                    const zAxisX = sa * sg - ca * sb * cg;
                    const zAxisY = -ca * sg - sa * sb * cg;
                    const zAxisZ = cb * cg;
                    
                    const cameraVector = { x: -zAxisX, y: -zAxisY, z: -zAxisZ };

                    elevation = satellite.radiansToDegrees(Math.asin(cameraVector.z));
                    azimuth = satellite.radiansToDegrees(Math.atan2(cameraVector.x, cameraVector.y));
                    if (azimuth < 0) azimuth += 360;
                    
                    const currentHeading = (azimuth + 90) % 360;

                    if (this.filteredHeading === null) {
                        this.filteredHeading = currentHeading;
                    } else {
                        const shortestAngleDist = (a1, a2) => {
                            const max = 360;
                            const da = (a2 - a1) % max;
                            return 2 * da % max - da;
                        };
                        
                        const diff = shortestAngleDist(this.filteredHeading, currentHeading);
                        
                        const smoothingFactor = Math.min(1, 0.1 + Math.abs(diff) / 180);
                        
                        this.filteredHeading = (this.filteredHeading + diff * smoothingFactor + 360) % 360;
                    }

                    this.updatePointer(elevation);
                }

                const lerpAngle = (a1, a2, t) => {
                    const shortestAngleDist = (a, b) => { let d = (b - a) % 360; return 2 * d % 360 - d; };
                    return (a1 + shortestAngleDist(a1, a2) * t + 360) % 360;
                };

                this.displayHeading = lerpAngle(this.displayHeading, this.filteredHeading !== null ? this.filteredHeading : 0, 0.15);
                
                // --- Lógica del cono de visión ---
                const isPointingUp = elevation > 1;
                const hasLocation = App.state.observerCoords;

                if (isPointingUp && hasLocation && App.state.map) {
                    const coneHeading = (this.filteredHeading + 180) % 360;
                    const angle = 60;
                    const maxRadius = 1000;
                    const segments = [
                        { inner: 0, outer: 400, opacity: 0.20 },
                        { inner: 400, outer: 750, opacity: 0.12 },
                        { inner: 750, outer: maxRadius, opacity: 0.06 }
                    ];

                    if (!App.state.viewConeLayer) {
                        App.state.viewConeLayer = L.layerGroup().addTo(App.state.map);
                    } else {
                        App.state.viewConeLayer.clearLayers();
                    }

                    segments.forEach(seg => {
                        const points = _createConeSegment(App.state.observerCoords, coneHeading, angle, seg.inner, seg.outer);
                        L.polygon(points, {
                            className: 'view-cone-segment',
                            fillColor: 'var(--color-secondary)',
                            fillOpacity: seg.opacity,
                            stroke: false
                        }).addTo(App.state.viewConeLayer);
                    });

                    const edgePoints = _calculateViewConePolygon(App.state.observerCoords, coneHeading, angle, maxRadius);
                    L.polyline([edgePoints[0], edgePoints[1]], { className: 'view-cone-edge' }).addTo(App.state.viewConeLayer);
                    L.polyline([edgePoints[0], edgePoints[2]], { className: 'view-cone-edge' }).addTo(App.state.viewConeLayer);

                } else {
                    if (App.state.viewConeLayer && App.state.map) {
                        App.state.map.removeLayer(App.state.viewConeLayer);
                        App.state.viewConeLayer = null;
                    }
                }
                // --- Fin de la lógica del cono ---

                this.drawRadarContent();

                this.animationFrameId = requestAnimationFrame(this.updateRadarAnimation);
            },
			updatePointer(elevation) {
				if (!this.activeCanvas || !this.activePointer) return;
				const rect = this.activeCanvas.getBoundingClientRect();
				const radius = rect.width / 2;
				const center = { x: radius, y: radius };
				
				const el = Math.max(0, Math.min(90, elevation));
				const distFromCenter = radius * ((90 - el) / 90);
				
				const x = center.x;
				const y = center.y + distFromCenter;
				
				this.activePointer.style.left = `${x}px`;
				this.activePointer.style.top = `${y}px`;
			},
			drawBase() {
				if (!this.activeCtx || !this.activeCanvas) return;
				const rect = this.activeCanvas.getBoundingClientRect();
				const radius = rect.width / 2;
				const center = { x: radius, y: radius };
				
				this.activeCtx.save();
				const rotationRads = satellite.degreesToRadians(this.displayHeading - 180);
				this.activeCtx.translate(center.x, center.y);
				this.activeCtx.rotate(rotationRads);
				this.activeCtx.translate(-center.x, -center.y);
				
				[30, 60].forEach(el => {
					this.activeCtx.beginPath();
					const ringRadius = radius * ((90 - el) / 90);
					this.activeCtx.arc(center.x, center.y, ringRadius, 0, 2 * Math.PI);
					this.activeCtx.strokeStyle = 'rgba(139, 148, 158, 0.2)';
					this.activeCtx.setLineDash([2, 3]);
					this.activeCtx.stroke();
				});
				this.activeCtx.setLineDash([]);
				
				this.activeCtx.beginPath();
				this.activeCtx.moveTo(center.x, 0); this.activeCtx.lineTo(center.x, rect.height);
				this.activeCtx.moveTo(0, center.y); this.activeCtx.lineTo(rect.width, center.y);
				this.activeCtx.strokeStyle = 'rgba(139, 148, 158, 0.2)';
				this.activeCtx.stroke();
				
				this.activeCtx.fillStyle = '#C9D1D9';

                let fontSize, textMargin;
                if (this.activeCanvas.id === 'large-radar-canvas') {
                    fontSize = 15;
                    textMargin = 18;
                } else {
                    fontSize = 9;
                    textMargin = 14;
                }
				this.activeCtx.font = `bold ${fontSize}px "Space Grotesk"`;

                const drawRotatedText = (text, x, y, baseRotation, align, baseline) => {
                    this.activeCtx.save();
                    this.activeCtx.translate(x, y);
                    this.activeCtx.rotate(baseRotation);
                    this.activeCtx.textAlign = align;
                    this.activeCtx.textBaseline = baseline;
                    this.activeCtx.fillText(text, 0, 0);
                    this.activeCtx.restore();
                };

                drawRotatedText('S', center.x, textMargin, Math.PI, 'center', 'top');
                drawRotatedText('N', center.x, rect.height - textMargin, Math.PI, 'center', 'bottom');
                drawRotatedText('E', rect.width - textMargin, center.y, Math.PI, 'right', 'middle');
                drawRotatedText('W', textMargin, center.y, Math.PI, 'left', 'middle');
			},
			calculateCurrentLookAngles(sat, time, coords) {
				if (!sat.satrec || !coords) return null;
				try {
					const observerGd = { latitude: satellite.degreesToRadians(coords[0]), longitude: satellite.degreesToRadians(coords[1]), height: 0.1 };
					const posVel = satellite.propagate(sat.satrec, new Date(time));
					const gmst = satellite.gstime(new Date(time));
					const posEcf = satellite.eciToEcf(posVel.position, gmst);
					const lookAngles = satellite.ecfToLookAngles(observerGd, posEcf);
					return {
						az: satellite.radiansToDegrees(lookAngles.azimuth),
						el: satellite.radiansToDegrees(lookAngles.elevation),
						posVel: posVel,
						gmst: gmst
					};
				} catch (e) {
					return null;
				}
			},

			calculateRaDecToAzEl(ra_h, dec_deg, time, coords) {
				const lat_rad = satellite.degreesToRadians(coords[0]);
				const lon_rad = satellite.degreesToRadians(coords[1]);
				const dec_rad = satellite.degreesToRadians(dec_deg);
				const ra_rad = satellite.degreesToRadians(ra_h * 15);
				
				const gmst = satellite.gstime(new Date(time));
				const lst = gmst + lon_rad;
				const ha = lst - ra_rad;
			
				const el_rad = Math.asin(Math.sin(dec_rad) * Math.sin(lat_rad) + Math.cos(dec_rad) * Math.cos(lat_rad) * Math.cos(ha));
			
				const y = -Math.cos(dec_rad) * Math.sin(ha);
				const x = Math.sin(dec_rad) * Math.cos(lat_rad) - Math.cos(dec_rad) * Math.sin(lat_rad) * Math.cos(ha);
				const az_rad = Math.atan2(y, x);
			
				return {
					az: satellite.radiansToDegrees(az_rad),
					el: satellite.radiansToDegrees(el_rad)
				};
			},

			drawRadarContent() {
				if (!this.activeCtx || !this.activeCanvas) return;
			
				this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
				this.drawBase();
			
				const rect = this.activeCanvas.getBoundingClientRect();
				const radius = rect.width / 2;
				const center = { x: radius, y: radius };
				const style = getComputedStyle(document.body);
				const coords = App.state.observerCoords;
				const warningColor = style.getPropertyValue('--color-warning').trim() || '#F7B530';
				const grayColor = style.getPropertyValue('--color-text-secondary').trim() || '#8B949E';
			
				if (coords) {
					// Determinar qué satélites dibujar y cuáles tienen trayectoria
					let satsForIcons = [];
					let satsForTrajectory = [];
			
					if (App.state.isNearbyModeActive) {
						satsForIcons = App.state.nearby.satellites;
						if (App.state.nearby.selectedSatForOrbit) {
							satsForTrajectory = [App.state.nearby.selectedSatForOrbit];
						}
					} else {
						satsForIcons = App.state.trackedSatellites;
						satsForTrajectory = App.state.isAllSatellitesMode ? 
							(App.state.selectedSatForOrbit ? [App.state.selectedSatForOrbit] : []) : 
							App.state.trackedSatellites;
					}
			
					// Dibujar trayectorias
					satsForTrajectory.forEach(sat => {
						const path = App.prediction.calculateSkyPath(sat, App.state.currentTime, coords);
						if (!path || path.length < 2) return;
			
						const segments = [];
						let currentSegment = { path: [], isVisible: path.length > 0 ? path[0].isVisible : false };
						path.forEach((point, i) => {
							if (i > 0) {
								const prevPoint = path[i-1];
								const timeGap = point.time.getTime() - prevPoint.time.getTime();
								const deltaAz = Math.abs(point.az - prevPoint.az);
								if (timeGap > 60000 || deltaAz > 180 || point.isVisible !== currentSegment.isVisible) {
									segments.push(currentSegment);
									currentSegment = { path: [], isVisible: point.isVisible };
								}
							}
							currentSegment.path.push(point);
						});
						segments.push(currentSegment);
			
						segments.forEach(segment => {
							if (segment.path.length < 2) return;
							const projectedPoints = segment.path.map(p => { const dist = radius * ((90-p.el)/90); const angle = satellite.degreesToRadians(p.az-90); return {x: center.x + dist*Math.cos(angle), y: center.y - dist*Math.sin(angle)}; });
							if (projectedPoints.length < 2) return;
							this.activeCtx.beginPath(); this.activeCtx.setLineDash(segment.isVisible ? [] : [5,5]);
							this.activeCtx.lineWidth = (this.activeCanvas.id === 'large-radar-canvas') ? 3.5 : 2.5;
							this.activeCtx.lineCap='round'; this.activeCtx.lineJoin='round';
							if(segment.isVisible){this.activeCtx.strokeStyle=warningColor; this.activeCtx.shadowColor=warningColor; this.activeCtx.shadowBlur=5;} else {this.activeCtx.strokeStyle=grayColor; this.activeCtx.shadowColor='transparent'; this.activeCtx.shadowBlur=0;}
							this.activeCtx.moveTo(projectedPoints[0].x, projectedPoints[0].y);
							for (let i = 1; i < projectedPoints.length; i++) { this.activeCtx.lineTo(projectedPoints[i].x, projectedPoints[i].y); }
							this.activeCtx.stroke();
						});
					});
			
					this.activeCtx.setLineDash([]); 
					this.activeCtx.shadowBlur = 0;
			
					// Dibujar iconos y etiquetas de satélites
					satsForIcons.forEach(sat => {
						const lookAnglesAndPos = this.calculateCurrentLookAngles(sat, App.state.currentTime, coords);
						if (lookAnglesAndPos && lookAnglesAndPos.el >= 0) {
							
							const { posVel, gmst, el, az } = lookAnglesAndPos;
							const isObserverDark = App.prediction._isObserverInDarkness(App.state.currentTime, coords);
							const isSatInSunlight = App.prediction.isSatIlluminated(posVel.position, App.state.currentTime);
							const isVisible = isObserverDark && isSatInSunlight && el > 10;

							const distFromCenter = radius * ((90 - el) / 90);
							const angleRad = satellite.degreesToRadians(az - 90);
							const satX = center.x + distFromCenter * Math.cos(angleRad);
							const satY = center.y - distFromCenter * Math.sin(angleRad);
							
							const futureLookAngles = this.calculateCurrentLookAngles(sat, new Date(App.state.currentTime.getTime() + 1000), coords);
							let bearingRad = 0;
							if (futureLookAngles) {
								const futureDist = radius * ((90 - futureLookAngles.el) / 90);
								const futureAngleRad = satellite.degreesToRadians(futureLookAngles.az - 90);
								const futureSatX = center.x + futureDist * Math.cos(futureAngleRad);
								const futureSatY = center.y - futureDist * Math.sin(futureAngleRad);
								bearingRad = Math.atan2(futureSatY - satY, futureSatX - satX);
							}
							
							this.activeCtx.save(); this.activeCtx.translate(satX, satY); this.activeCtx.rotate(bearingRad);
							let satIconSize = (this.activeCanvas.id === 'large-radar-canvas') ? 12 : 9;
							
							this.activeCtx.fillStyle = isVisible ? (style.getPropertyValue('--color-satellite-icon').trim() || '#FFEB3B') : grayColor;
							this.activeCtx.strokeStyle = 'rgba(255,255,255,0.9)'; this.activeCtx.lineWidth = 1.5;
							this.activeCtx.shadowColor = isVisible ? this.activeCtx.fillStyle : 'transparent';
							this.activeCtx.shadowBlur = isVisible ? 8 : 0;

							this.activeCtx.beginPath(); this.activeCtx.moveTo(satIconSize*0.8,0); this.activeCtx.lineTo(-satIconSize*0.4, -satIconSize*0.5); this.activeCtx.lineTo(-satIconSize*0.4, satIconSize*0.5); this.activeCtx.closePath(); this.activeCtx.fill(); this.activeCtx.stroke(); this.activeCtx.restore();
			
							this.activeCtx.save(); this.activeCtx.translate(satX, satY); this.activeCtx.rotate(-satellite.degreesToRadians(this.displayHeading - 180));
							this.activeCtx.shadowBlur = 0;
							const satFontSize = (this.activeCanvas.id === 'large-radar-canvas') ? 13 : 11;
							this.activeCtx.font = `bold ${satFontSize}px "Space Grotesk"`;
							this.activeCtx.fillStyle = isVisible ? '#C9D1D9' : grayColor;
							this.activeCtx.textAlign = 'left';
							this.activeCtx.textBaseline = 'middle';
							const satLabelOffset = (this.activeCanvas.id === 'large-radar-canvas') ? 15 : 12;
							this.activeCtx.fillText(sat.name, satLabelOffset, 0); this.activeCtx.restore();
						}
					});
				
					const moonPosition = SunCalc.getMoonPosition(App.state.currentTime, coords[0], coords[1]);
					const moonEl = satellite.radiansToDegrees(moonPosition.altitude);
                    const moonIconEl = this.activeCanvas.id === 'large-radar-canvas' ? App.elements.largeRadarMoonIcon : App.elements.radarMoonIcon;
					
					if (moonEl >= 0 && moonIconEl) {
						const moonAz = (satellite.radiansToDegrees(moonPosition.azimuth) + 180) % 360;
						const distFromCenter = radius * ((90 - moonEl) / 90);
						const angleRad = satellite.degreesToRadians(moonAz - 90);
						const unrotatedX = center.x + distFromCenter * Math.cos(angleRad);
						const unrotatedY = center.y - distFromCenter * Math.sin(angleRad);
						
						const rotationRads = satellite.degreesToRadians(this.displayHeading - 180);
						const cosR = Math.cos(rotationRads);
						const sinR = Math.sin(rotationRads);
						const dx = unrotatedX - center.x;
						const dy = unrotatedY - center.y;
						const rotatedDx = dx * cosR - dy * sinR;
						const rotatedDy = dx * sinR + dy * cosR;
						const finalMoonX = center.x + rotatedDx;
						const finalMoonY = center.y + rotatedDy;

                        const moonInfo = SunCalc.getMoonIllumination(App.state.currentTime);
                        const phase = moonInfo.phase;
                        const isSouthernHemisphere = App.state.observerCoords ? App.state.observerCoords[0] < 0 : false;
                        let translationPercent;
                        if (phase <= 0.5) {
                            const progress = phase / 0.5;
                            translationPercent = isSouthernHemisphere ? progress * 100 : progress * -100;
                        } else {
                            const progress = (phase - 0.5) / 0.5;
                            translationPercent = isSouthernHemisphere ? -100 + (progress * 100) : 100 - (progress * 100);
                        }
                        
                        moonIconEl.classList.remove('hidden');
                        moonIconEl.style.left = `${finalMoonX}px`;
                        moonIconEl.style.top = `${finalMoonY}px`;
                        const shadowEl = moonIconEl.querySelector('.moon-phase-shadow');
                        if(shadowEl) shadowEl.style.transform = `translateX(${translationPercent}%)`;

						this.activeCtx.save();
						this.activeCtx.translate(unrotatedX, unrotatedY);
						this.activeCtx.rotate(-satellite.degreesToRadians(this.displayHeading - 180));
						this.activeCtx.shadowBlur = 0;
						const moonFontSize = (this.activeCanvas.id === 'large-radar-canvas') ? 13 : 11;
						this.activeCtx.font = `bold ${moonFontSize}px "Space Grotesk"`;
						this.activeCtx.fillStyle = '#E0E0E0';
						this.activeCtx.textAlign = 'left';
						this.activeCtx.textBaseline = 'middle';
						const moonLabelOffset = (this.activeCanvas.id === 'large-radar-canvas') ? 14 : 12;
						this.activeCtx.fillText(App.language.getTranslation('radarMoonLabel'), moonLabelOffset, 0);
						this.activeCtx.restore();
					} else if (moonIconEl) {
                        moonIconEl.classList.add('hidden');
                    }

					if (this.activeCanvas.id === 'large-radar-canvas') {
						const projectedObjects = {};
						const beltStars = [];
					
						Object.entries(this.BRIGHT_OBJECTS).forEach(([name, data]) => {
							const pos = this.calculateRaDecToAzEl(data.ra, data.dec, App.state.currentTime, coords);
							if (pos && pos.el > 0) {
								const dist = radius * ((90 - pos.el) / 90);
								const angle = satellite.degreesToRadians(pos.az - 90);
								const objX = center.x + dist * Math.cos(angle);
								const objY = center.y - dist * Math.sin(angle);
								
								projectedObjects[name] = { x: objX, y: objY, data: data };
								if (data.belt) {
									beltStars.push(projectedObjects[name]);
								}
							}
						});
					
						let orionBeltCenter = null;
						if (beltStars.length === 3) {
							const maxDist = 25; 
							const d1 = Math.hypot(beltStars[0].x - beltStars[1].x, beltStars[0].y - beltStars[1].y);
							const d2 = Math.hypot(beltStars[1].x - beltStars[2].x, beltStars[1].y - beltStars[2].y);
							
							if (d1 < maxDist && d2 < maxDist) {
								orionBeltCenter = {
									x: (beltStars[0].x + beltStars[1].x + beltStars[2].x) / 3,
									y: (beltStars[0].y + beltStars[1].y + beltStars[2].y) / 3
								};
							}
						}
					
						if (orionBeltCenter) {
							beltStars.forEach(star => {
								this.activeCtx.beginPath();
								this.activeCtx.arc(star.x, star.y, 2.5, 0, 2 * Math.PI);
								this.activeCtx.fillStyle = 'rgba(220, 220, 255, 0.9)';
								this.activeCtx.fill();
							});
					
							this.activeCtx.save();
							this.activeCtx.translate(orionBeltCenter.x, orionBeltCenter.y);
							this.activeCtx.rotate(-satellite.degreesToRadians(this.displayHeading - 180));
							this.activeCtx.shadowBlur = 0;
							this.activeCtx.font = 'bold 13px "Space Grotesk"';
							this.activeCtx.fillStyle = '#C9D1D9';
							this.activeCtx.textAlign = 'left';
							this.activeCtx.textBaseline = 'middle';
							this.activeCtx.fillText('Cinturón de Orión', 10, 0);
							this.activeCtx.restore();
						}
					
						Object.entries(projectedObjects).forEach(([name, proj]) => {
							if (orionBeltCenter && proj.data.belt) {
								return;
							}
					
							this.activeCtx.beginPath();
							if (proj.data.type === 'planet') {
								this.activeCtx.arc(proj.x, proj.y, 5.5, 0, 2 * Math.PI);
								this.activeCtx.fillStyle = 'rgba(255, 220, 180, 0.9)';
							} else {
								this.activeCtx.arc(proj.x, proj.y, 3.5, 0, 2 * Math.PI);
								this.activeCtx.fillStyle = 'rgba(220, 220, 255, 0.9)';
							}
							this.activeCtx.fill();
					
							this.activeCtx.save();
							this.activeCtx.translate(proj.x, proj.y);
							this.activeCtx.rotate(-satellite.degreesToRadians(this.displayHeading - 180));
							this.activeCtx.shadowBlur = 0;
							this.activeCtx.font = 'bold 13px "Space Grotesk"';
							this.activeCtx.fillStyle = '#C9D1D9';
							this.activeCtx.textAlign = 'left';
							this.activeCtx.textBaseline = 'middle';
							this.activeCtx.fillText(name, 14, 0);
							this.activeCtx.restore();
						});
					}
				}
				
				this.activeCtx.restore();
			},
			clearTrajectory() {
				if(this.activeCtx) {
					this.drawRadarContent();
				}
			}
		},
		settings: {
			current: {},
			defaults: {
				language: 'es',
				defaultMapLayer: 'dark',
				defaultNightOverlay: false, // Nuevo ajuste por defecto
				showNightOverlay: false     // Estado actual, no un ajuste guardable
			},
			init() {
				this.load();
			},
			load() {
				try {
					const savedSettings = JSON.parse(localStorage.getItem(App.config.settingsStorageKey));
					
                    if (!savedSettings) {
                        const browserLang = navigator.language.slice(0, 2); 
                        const supportedLangs = ['es', 'en'];

                        if (supportedLangs.includes(browserLang)) {
                            this.current = { ...this.defaults, language: browserLang };
                        } else {
                            this.current = { ...this.defaults };
                        }
                    } else {
                        this.current = { ...this.defaults, ...savedSettings };
                    }
                    
                    // El estado actual de la capa se establece basado en el ajuste por defecto
                    this.current.showNightOverlay = this.current.defaultNightOverlay;

				} catch (e) {
					this.current = { ...this.defaults };
                    this.current.showNightOverlay = this.current.defaultNightOverlay;
				}
			},
			save() {
				try {
					localStorage.setItem(App.config.settingsStorageKey, JSON.stringify(this.current));
				} catch (e) {
					console.error("Error al guardar la configuración:", e);
				}
			},
			setMapMode(mode) {
				if (mode === this.current.defaultMapLayer) return;
				App.playSound('uiClick', 'D4');
				this.current.defaultMapLayer = mode;
				this.save();
				this.updateUI();
			},
			setDefaultNightOverlay(show) {
				if (show === this.current.defaultNightOverlay) return;
				App.playSound('uiClick', 'D4');
				this.current.defaultNightOverlay = show;
				this.current.showNightOverlay = show; // Actualiza también el estado actual
				this.save();
				this.updateUI();
				// Actualiza el mapa en tiempo real si está visible
				if (App.state.mapInitialized) {
					App.elements.toggleNightOverlayBtn.checked = show;
					App.nightOverlay.update();
				}
			},
			setNightOverlay(show) {
				if (show === this.current.showNightOverlay) return;
				App.playSound('uiClick', 'D4');
				this.current.showNightOverlay = show;
				this.save();
				App.nightOverlay.update();
			},
			setLanguage(lang) {
				if (lang === this.current.language) return;
				App.playSound('uiClick', 'D4');
				this.current.language = lang;
				this.save();
				App.language.set(lang);
				this.updateUI();

				if (App.state.mapInitialized) {
					const maptilerApiKey = 'T0Hykq7m9NBM9wLS2eIw';
					const newDarkUrl = `https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}@2x.png?key=${maptilerApiKey}&language=${lang}`;
					const newSatelliteUrl = `https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}@2x.jpg?key=${maptilerApiKey}&language=${lang}`;
					
					App.state.baseLayers.dark.setUrl(newDarkUrl);
					App.state.baseLayers.satellite.setUrl(newSatelliteUrl);
				}
			},
			updateUI() {
				const { settingMapDark, settingMapSatellite, settingDayNightOn, settingDayNightOff, currentLanguageDisplay, languageDropdownMenu, toggleNightOverlayBtn } = App.elements;
				
				if (toggleNightOverlayBtn) {
					toggleNightOverlayBtn.checked = this.current.showNightOverlay;
				}

				if (settingMapDark && settingMapSatellite) {
					settingMapDark.classList.toggle('active', this.current.defaultMapLayer === 'dark');
					settingMapSatellite.classList.toggle('active', this.current.defaultMapLayer === 'satellite');
				}

				if (settingDayNightOn && settingDayNightOff) {
					settingDayNightOn.classList.toggle('active', this.current.defaultNightOverlay === true);
					settingDayNightOff.classList.toggle('active', this.current.defaultNightOverlay === false);
				}
				
				if (currentLanguageDisplay && languageDropdownMenu) {
					const langMap = { es: 'Español', en: 'English' };
					currentLanguageDisplay.textContent = langMap[this.current.language] || 'Español';

					languageDropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
						item.classList.toggle('active', item.dataset.lang === this.current.language);
					});
				}
			}
		},
		moon: {
			showScreen() {
				const container = App.elements.moonPhaseContainer;
				if (!container) return;
		
				container.innerHTML = '';
		
				if (!App.state.observerCoords) {
					container.innerHTML = `<p class="text-text-secondary text-center p-8 border-2 border-dashed border-gray-700 rounded-lg" data-lang-key="setLocationForBestPasses">${App.language.getTranslation('setLocationForBestPasses')}</p>`;
					return;
				}
		
				const fragment = document.createDocumentFragment();
				const today = new Date();
				today.setHours(0, 0, 0, 0);
		
				for (let i = 0; i < 30; i++) {
					const date = new Date(today);
					date.setDate(date.getDate() + i);
					const card = this.createDayCard(date, i === 0);
					fragment.appendChild(card);
				}
		
				container.appendChild(fragment);
			},
		
			createDayCard(date, isToday) {
				const [lat, lon] = App.state.observerCoords;
				const moonInfo = SunCalc.getMoonIllumination(date);
				const moonTimes = SunCalc.getMoonTimes(date, lat, lon);
				const phase = moonInfo.phase;
		
				const card = document.createElement('div');
				card.className = 'moon-day-card mb-2';
				if (isToday) {
					card.classList.add('is-today');
				}
				if (phase >= 0.47 && phase < 0.53) {
                    card.classList.add('is-full-moon');
                }
		
				const phaseName = this.getPhaseName(phase);
				const illumination = (moonInfo.fraction * 100).toFixed(0) + '%';
		
				const isSouthernHemisphere = lat < 0;
				let translationPercent;
				if (phase <= 0.5) {
					const progress = phase / 0.5;
					translationPercent = isSouthernHemisphere ? progress * 100 : progress * -100;
				} else {
					const progress = (phase - 0.5) / 0.5;
					translationPercent = isSouthernHemisphere ? -100 + (progress * 100) : 100 - (progress * 100);
				}
		
				const timeOptions = { hour: '2-digit', minute: '2-digit' };
				const riseTime = moonTimes.rise ? App.time.formatCityTime(moonTimes.rise, timeOptions) : '--:--';
				const setTime = moonTimes.set ? App.time.formatCityTime(moonTimes.set, timeOptions) : '--:--';
				const dateOptions = { day: 'numeric', month: 'long' };
				const formattedDate = isToday ? App.language.getTranslation('today') : App.time.formatCityTime(date, dateOptions);
		
				card.innerHTML = `
					<div class="moon-phase-visual">
						<div class="moon-phase-shadow" style="transform: translateX(${translationPercent}%);"></div>
					</div>
					<div class="moon-day-info">
						<div class="moon-date">${formattedDate}</div>
						<div class="moon-phase-name">${phaseName}</div>
					</div>
					<div class="moon-day-details">
						<div class="moon-illumination">${illumination}</div>
						<div class="moon-times mt-1">
							<div class="flex items-center justify-end">
								<i class="fa-solid fa-arrow-up w-4 text-center mr-1"></i>
								<span>${riseTime}</span>
							</div>
							<div class="flex items-center justify-end mt-1">
								<i class="fa-solid fa-arrow-down w-4 text-center mr-1"></i>
								<span>${setTime}</span>
							</div>
						</div>
					</div>
				`;
				return card;
			},
		
			getPhaseName(phase) {
				if (phase < 0.03 || phase > 0.97) return App.language.getTranslation('moonPhaseNew');
				if (phase < 0.22) return App.language.getTranslation('moonPhaseWaxingCrescent');
				if (phase < 0.28) return App.language.getTranslation('moonPhaseFirstQuarter');
				if (phase < 0.47) return App.language.getTranslation('moonPhaseWaxingGibbous');
				if (phase < 0.53) return App.language.getTranslation('moonPhaseFull');
				if (phase < 0.72) return App.language.getTranslation('moonPhaseWaningGibbous');
				if (phase < 0.78) return App.language.getTranslation('moonPhaseLastQuarter');
				return App.language.getTranslation('moonPhaseWaningCrescent');
			}
		},
		language: {
			loadedTranslations: {},
		
			async set(lang) {
				if (!lang) lang = 'es'; 
		
				if (!this.loadedTranslations[lang]) {
					try {
						const response = await fetch(`lang/${lang}.json`);
						if (!response.ok) {
							throw new Error(`No se pudo cargar el archivo de idioma: ${response.statusText}`);
						}
						this.loadedTranslations[lang] = await response.json();
					} catch (error) {
						console.error('Error al cargar las traducciones:', error);
						if (lang !== 'es') {
							await this.set('es');
						}
						return; 
					}
				}
		
				const translations = this.loadedTranslations[lang];
				document.documentElement.lang = lang;
		
				document.querySelectorAll('[data-lang-key]').forEach(el => {
					const key = el.dataset.langKey;
					const translationData = this.getTranslation(key, true);
				
					if (translationData !== undefined) {
						let textToSet = null;
				
						if (typeof translationData === 'string') {
							textToSet = translationData;
						} else if (typeof translationData === 'object' && translationData !== null) {
							if (translationData.placeholder) el.placeholder = translationData.placeholder;
							if (translationData.title) el.title = translationData.title;
							if (translationData.ariaLabel) el.setAttribute('aria-label', translationData.ariaLabel);
							if (translationData.text) {
								textToSet = translationData.text;
							}
						}
				
						if (textToSet !== null) {
							const isHtml = /<[a-z][\s\S]*>/i.test(textToSet);
				
							if (isHtml) {
								el.innerHTML = textToSet;
							} else {
								if (el.children.length === 0) {
									el.textContent = textToSet;
								} else {
									let replaced = false;
									for (const node of el.childNodes) {
										if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
											node.textContent = textToSet;
											replaced = true;
											break;
										}
									}
								}
							}
						}
					}
				});
			},
		
			getTranslation(key, returnObject = false) {
				const lang = App.settings.current.language || 'es';
				const translations = this.loadedTranslations[lang];
				if (!translations) return `[${key}]`;
			
				const keys = key.split('.');
				let result = translations;
				for (const k of keys) {
					result = result[k];
					if (result === undefined) return `[${key}]`;
				}
			
				if (!returnObject && typeof result === 'object' && result !== null && result.text) {
					return result.text;
				}
				
				return result;
			}
		},
		notifications: {
			currentPass: null,
			currentButton: null,
			storageKey: 'satelitesarg_scheduled_notifications',
			timeoutIds: {},

			_getPassId(pass) {
				const tleId = getTleId(pass.tle || (this.currentPass && this.currentPass.tle));
				const startTime = pass.start || (this.currentPass && this.currentPass.start);
				return `${tleId}_${new Date(startTime).getTime()}`;
			},

			_loadScheduled() {
				try {
					return JSON.parse(localStorage.getItem(this.storageKey)) || {};
				} catch (e) {
					return {};
				}
			},

			_saveScheduled(notifications) {
				localStorage.setItem(this.storageKey, JSON.stringify(notifications));
			},

			init() {
				const { elements } = App;
				const manualHide = () => {
					const modal = App.elements.notificationModal;
					modal.classList.remove('is-visible');
					setTimeout(() => modal.classList.add('hidden'), 400);
				};

				elements.closeNotificationModalBtn.addEventListener('click', () => {
					App.playSound('uiClick', 'A3');
					manualHide();
				});

				elements.doneNotificationModalBtn.addEventListener('click', () => {
					App.playSound('uiClick', 'A3');
					manualHide();
				});

				elements.notificationOptions.addEventListener('click', (e) => {
					const button = e.target.closest('button');
					if (button && button.dataset.minutes) {
						const minutes = parseInt(button.dataset.minutes, 10);
						this.toggle(minutes, button);
					}
				});
				
				this.rescheduleOnLoad();
			},

			openModal(passInfoString, buttonElement) {
				App.playSound('uiClick', 'D4');
				this.currentPass = JSON.parse(passInfoString);
				this.currentButton = buttonElement;

				const scheduled = this._loadScheduled();
				const passId = this._getPassId(this.currentPass);
				const scheduledForThisPass = scheduled[passId] || [];
				
				App.elements.notificationOptions.querySelectorAll('button').forEach(btn => {
					const minutes = parseInt(btn.dataset.minutes, 10);
					btn.classList.toggle('notification-btn-active', scheduledForThisPass.includes(minutes));
				});
				
				const modal = App.elements.notificationModal;
				modal.classList.remove('hidden');
				setTimeout(() => modal.classList.add('is-visible'), 10);
			},

			async toggle(minutes, btnElement) {
				if (!('Notification' in window)) {
					App.ui.showToast(App.language.getTranslation('notifications.notSupported'), 'error');
					return;
				}
			
				if (Notification.permission !== 'granted') {
					if (Notification.permission === 'denied') {
						App.ui.showToast(App.language.getTranslation('notifications.denied'), 'error');
						return;
					}
					const permission = await Notification.requestPermission();
					if (permission !== 'granted') {
						App.ui.showToast(App.language.getTranslation('notifications.denied'), 'error');
						return;
					}
				}
				
				const scheduled = this._loadScheduled();
				const passId = this._getPassId(this.currentPass);
				if (!scheduled[passId]) scheduled[passId] = [];

				const isScheduled = scheduled[passId].includes(minutes);
				const timeoutIdKey = `${passId}_${minutes}`;

				if (isScheduled) {
					scheduled[passId] = scheduled[passId].filter(m => m !== minutes);
					if (scheduled[passId].length === 0) {
						delete scheduled[passId];
					}
					this._saveScheduled(scheduled);
					btnElement.classList.remove('notification-btn-active');
					
					if (this.timeoutIds[timeoutIdKey]) {
						clearTimeout(this.timeoutIds[timeoutIdKey]);
						delete this.timeoutIds[timeoutIdKey];
					}

					App.ui.showToast(App.language.getTranslation('notifications.cancelled'), 'error');

					const bellIcon = this.currentButton.querySelector('i');
					if (bellIcon && (!scheduled[passId] || scheduled[passId].length === 0)) {
						bellIcon.classList.replace('fa-solid', 'fa-regular');
						this.currentButton.style.color = '';
					}
					
				} else {
					const notifyAt = new Date(this.currentPass.start - (minutes * 60 * 1000));
					const delay = notifyAt.getTime() - Date.now();

					if (delay <= 0) {
						App.ui.showToast(App.language.getTranslation('notifications.tooLate'), 'error');
						return;
					}

					scheduled[passId].push(minutes);
					this._saveScheduled(scheduled);
					btnElement.classList.add('notification-btn-active');

					this.timeoutIds[timeoutIdKey] = setTimeout(() => {
						this.show(this.currentPass, minutes);
						const currentScheduled = this._loadScheduled();
						if (currentScheduled[passId]) {
							currentScheduled[passId] = currentScheduled[passId].filter(m => m !== minutes);
							if (currentScheduled[passId].length === 0) delete currentScheduled[passId];
							this._saveScheduled(currentScheduled);
						}
					}, delay);

					const successMsg = App.language.getTranslation('notifications.success')
						.replace('{name}', this.currentPass.satName)
						.replace('{time}', App.time.formatCityTime(notifyAt, { hour: '2-digit', minute: '2-digit' }));
					App.ui.showToast(successMsg, 'success');

					const bellIcon = this.currentButton.querySelector('i');
					if (bellIcon) {
						bellIcon.classList.replace('fa-regular', 'fa-solid');
						this.currentButton.style.color = 'var(--color-success)';
					}
				}
			},

			async show(pass, minutes) {
				const title = App.language.getTranslation('notifications.title').replace('{name}', pass.satName);
				const body = App.language.getTranslation('notifications.body')
					.replace('{minutes}', minutes)
					.replace('{elevation}', pass.maxElevation.toFixed(0));

				const options = { body: body, icon: 'images/icon-192.png', badge: 'images/icon-192.png' };

				try {
					const registration = await navigator.serviceWorker.ready;
					await registration.showNotification(title, options);
				} catch (err) { console.error('Error al mostrar la notificación:', err); }
			},

			rescheduleOnLoad() {
				const scheduled = this._loadScheduled();
				const now = Date.now();
				let updatedScheduled = {};
				
				for (const passId in scheduled) {
					const [tle, startTime] = passId.split('_');
					const passStart = parseInt(startTime, 10);
					
					if (passStart > now) {
						updatedScheduled[passId] = [];
						const minutesArray = scheduled[passId];
						
						minutesArray.forEach(minutes => {
							const notifyAt = new Date(passStart - (minutes * 60 * 1000));
							const delay = notifyAt.getTime() - now;

							if (delay > 0) {
								updatedScheduled[passId].push(minutes);
								const timeoutIdKey = `${passId}_${minutes}`;

								const passInfoForNotif = { 
									 satName: "Satélite", 
									 maxElevation: 0, 
								};

								this.timeoutIds[timeoutIdKey] = setTimeout(() => {
									this.show(passInfoForNotif, minutes);
								}, delay);
							}
						});
						if (updatedScheduled[passId].length === 0) {
							delete updatedScheduled[passId];
						}
					}
				}
				this._saveScheduled(updatedScheduled);
			}
		}
	};
	App.init();
});
