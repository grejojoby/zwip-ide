import { SqlService } from './sql';
import { serve } from './transport';
const service = new SqlService(process.argv[2]);
serve(
  (method, params) => service.dispatch(method, params),
  () => service.dispose(),
);
