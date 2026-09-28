import { ShipFromDto } from './ship-from.dto';

// a location's name is set at creation; afterwards only its ship-from
// details change
export class UpdateLocationDto extends ShipFromDto {}
