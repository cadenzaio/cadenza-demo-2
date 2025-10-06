import Cadenza from '@cadenza.io/service';
import { iotHealthSchema } from './schema.js';

Cadenza.createDatabaseService(
  'IotDbService', // @ts-ignore
  iotHealthSchema,
  'IoT Database Service',
  {
    cadenzaDB: {
      connect: true,
      address: process.env.CADENZA_DB_ADDRESS ?? 'cadenza-db-service',
      port: parseInt(process.env.CADENZA_DB_PORT ?? '8080'),
    },
  }
);
