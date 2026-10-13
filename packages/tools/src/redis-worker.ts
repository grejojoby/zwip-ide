import { RedisService } from './redis';
import { serve } from './transport';
const service = new RedisService();
serve(
  (method, params) => service.dispatch(method, params),
  () => service.dispose(),
);
