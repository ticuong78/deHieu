import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupOpenApi } from './shared/presentation/openapi-document.js';
import { httpDiagnostics } from './shared/presentation/http-diagnostics.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.use(
    httpDiagnostics({
      logSuccess: process.env.HTTP_DIAGNOSTICS_LOG_SUCCESS === 'true',
    }),
  );
  // Tài liệu API (Swagger UI) tại /docs. Tắt bằng API_DOCS_ENABLED=false.
  if (process.env.API_DOCS_ENABLED !== 'false') setupOpenApi(app);
  await app.listen(
    process.env.PORT ?? 3000,
    process.env.HTTP_BIND_HOST ?? '0.0.0.0',
  );
}
await bootstrap();
