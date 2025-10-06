import CadenzaDB from '@cadenza.io/cadenza-db';

CadenzaDB.createCadenzaDBService({
  dropExisting: false,
});
console.log(
  'DatabaseService started',
);