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
1 72000C 25216A   25268.40470463  .00018403  00000+0  32977-4 0    06
2 72000  53.1632  31.1073 0006757 288.3871 346.5537 16.00923872    10`
        },

        /*
        {
            tle: ``
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