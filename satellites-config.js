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
            tle: `TARLINK-G10-27 SINGLE  
1 72001C 25212B   25264.49808148  .01097600  00000+0  17662-2 0    02
2 72001  53.1624  60.8392 0010969 267.8465   7.8625 16.02316865    11`
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