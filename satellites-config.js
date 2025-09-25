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
            tle: `STARLINK-G17-11 STACK   
1 72000C 25218A   25269.17728241  .00029418  00000+0  45280-4 0    02
2 72000  97.6077 109.1761 0010566 246.9910 128.9829 16.04161332    18`
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