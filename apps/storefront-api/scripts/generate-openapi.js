"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const fs_1 = require("fs");
const swagger_1 = require("@nestjs/swagger");
const app_module_1 = require("../src/app.module");
const swagger_config_1 = require("../src/swagger.config");
async function generate() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { logger: false });
    const document = swagger_1.SwaggerModule.createDocument(app, (0, swagger_config_1.createSwaggerConfig)());
    (0, fs_1.writeFileSync)('./openapi.json', JSON.stringify(document, null, 2));
    await app.close();
}
generate();
//# sourceMappingURL=generate-openapi.js.map