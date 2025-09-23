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

        
        {
            tle: `STARLINK-G17-11 STACK   
1 72000C 25218A   25269.12438333  .00029030  00000+0  45534-4 0    09
2 72000  97.6075  90.0824 0010516 254.0756 121.8600 16.03847818    15
STARLINK-G17-11 SINGLE  
1 72001C 25218B   25269.12438333  .01320300  00000+0  20171-2 0    03
2 72001  97.6073  90.0824 0010390 254.9159 121.0191 16.03849263    13`
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