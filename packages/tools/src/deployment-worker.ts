import { DeploymentService } from './deployment/service';
import { serve } from './transport';
const service = new DeploymentService();
serve(
  (method, params) => service.dispatch(method, params),
  () => service.dispose(),
);
