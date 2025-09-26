// satellites-config.js

// Este objeto global contendrá toda la configuración de satélites
// que antes estaba dentro de App.config en script.js.
const SATELLITES_CONFIG = {

    // Lista de satélites populares o conocidos
    knownSatellites: {
        'iss': {
            name: 'Estación Espacial (ISS)',
            noradId: 25544,
            tle: null,
            icon: 'fa-igloo',
            description: 'El laboratorio orbital más grande del mundo.'
        },
        'tiangong': {
            name: 'Estación Espacial (Tiangong)',
            noradId: 48274,
            tle: null,
            icon: 'fa-building-columns',
            description: 'Estación espacial modular de China.'
        },
        'hubble': {
            name: 'Telescopio Espacial Hubble',
            noradId: 20580,
            tle: null,
            icon: 'fa-satellite',
            description: 'Un observatorio espacial icónico.'
        }
    },

    // Lista de los últimos Starlinks (actualizar manualmente cuando sea necesario)
    latestStarlinks: [
        {
            tle: `STARLINK-G10-15 STACK   
1 72000C 25216A   25268.40493611  .00018482  00000+0  33118-4 0    01
2 72000  53.1632  31.1909 0006757 288.3872 346.5536 16.00923870    16`
        },

        
        {
            tle: `STARLINK-G17-11B3 STACK 
1 72000C 25218A   25269.22681944  .00028096  00000+0  43246-4 0    07
2 72000  97.6076 127.0583 0010566 246.9739 129.0000 16.04161319    15`
        },

        /*
        {
            tle: `PEGAR TLE`
        }
        */
    ],

    // Esta lista se cargará dinámicamente desde CelesTrak
    brightestSatellites: []
};

// Base de datos de eventos astronómicos anuales
const EVENTS_DATA = {
    meteorShowers: [
        {
            name_es: "Cuadrántidas",
            desc_es: "Una de las lluvias más activas del año, ideal para el Hemisferio Norte.",
            start_month: 1, start_day: 1, end_month: 1, end_day: 6,
            hemisphere: 'N'
        },
        {
            name_es: "Líridas",
            desc_es: "Produce meteoros rápidos y brillantes, visibles en ambos hemisferios pero con preferencia por el norte.",
            start_month: 4, start_day: 16, end_month: 4, end_day: 25,
            hemisphere: 'Both'
        },
        {
            name_es: "Eta Acuáridas",
            desc_es: "Restos del cometa Halley. Ofrece un excelente espectáculo en el Hemisferio Sur.",
            start_month: 4, start_day: 19, end_month: 5, end_day: 28,
            hemisphere: 'S'
        },
        {
            name_es: "Delta Acuáridas del Sur",
            desc_es: "Perfecta para observadores del sur, esta lluvia ofrece meteoros débiles pero constantes.",
            start_month: 7, start_day: 12, end_month: 8, end_day: 23,
            hemisphere: 'S'
        },
        {
            name_es: "Perseidas",
            desc_es: "La lluvia de estrellas más popular del verano del Hemisferio Norte, famosa por sus brillantes bólidos.",
            start_month: 7, start_day: 17, end_month: 8, end_day: 24,
            hemisphere: 'N'
        },
        {
            name_es: "Oriónidas",
            desc_es: "Otra lluvia asociada al cometa Halley, visible desde ambos hemisferios con meteoros muy veloces.",
            start_month: 10, start_day: 2, end_month: 11, end_day: 7,
            hemisphere: 'Both'
        },
        {
            name_es: "Leónidas",
            desc_es: "Conocida por sus espectaculares tormentas de meteoros cada 33 años. Visible globalmente.",
            start_month: 11, start_day: 6, end_month: 11, end_day: 30,
            hemisphere: 'Both'
        },
        {
            name_es: "Gemínidas",
            desc_es: "Considerada la reina de las lluvias de estrellas, con meteoros multicolores y una alta actividad.",
            start_month: 12, start_day: 4, end_month: 12, end_day: 17,
            hemisphere: 'Both'
        }
    ],
    comets: [
        {
            name_es: "Cometa C/2023 A3 (Tsuchinshan-ATLAS)",
            desc_es: "Un cometa con el potencial de convertirse en un espectáculo a simple vista a finales de 2024.",
            hemisphere: 'Both' // O especificar 'N' o 'S' si es el caso
        }
    ]
};