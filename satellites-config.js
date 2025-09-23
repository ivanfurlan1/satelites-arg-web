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
1 72000C 25216A   25268.40285278  .00008750  00000+0  15682-4 0    02
2 72000  53.1632  30.4388 0006755 288.3786 346.5622 16.00923935    19
STARLINK-G10-15 SINGLE  
1 72001C 25216B   25268.40285278  .00857960  00000+0  15129-2 0    02
2 72001  53.1631  30.4388 0006902 289.7240 345.2165 16.00920207    10`
        },

        /*
        {
            tle: ``
        },

        /*
        {
            tle: `PEGAR TLE`
        }
        /*
    ],

    // Esta lista se cargará dinámicamente desde CelesTrak
    brightestSatellites: []
};