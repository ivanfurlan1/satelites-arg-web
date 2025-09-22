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
            tle: `STARLINK-G10-27 STACK   
1 72000C 25212A   25264.49808148  .00017435  00000+0  28658-4 0    07
2 72000  53.1625  60.8391 0010788 266.8683   8.8411 16.02321381    13`
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