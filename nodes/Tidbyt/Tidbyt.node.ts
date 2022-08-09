import { debuglog } from 'util';
import { IExecuteFunctions } from 'n8n-core';
import {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeOperationError,
} from 'n8n-workflow';

import {
	nodeDescription,
} from './Tidbyt.node.options';

import { ITidbytCredentials } from './Tidbyt.node.types';

import * as fs from 'fs';
import { TextDecoder, TextEncoder } from 'util';
import * as WebP from 'node-webpmux';
import * as TidbytApi from 'tidbyt';
import * as crypto from 'crypto';
import * as path from 'path';
const debug = debuglog('n8n-nodes-tidbyt');

(globalThis as any).require = require;
(globalThis as any).fs = fs;
(globalThis as any).TextEncoder = TextEncoder;
(globalThis as any).TextDecoder = TextDecoder;
(globalThis as any).performance = {
	now() {
		const [sec, nsec] = process.hrtime();
		return sec * 1000 + nsec / 1000000;
	},
};
(globalThis as any).crypto = {
	getRandomValues(b: any) {
		crypto.randomFillSync(b);
	},
};

require("./wasm_exec");

const go = new (global as any).Go();
go.env = Object.assign({ TMPDIR: require("os").tmpdir() }, process.env);

function loadPixlet(wasm: Buffer) {
    return (global as any).WebAssembly.instantiate(wasm, go.importObject).then((result: any) => {
        go.run(result.instance);
        return new Promise(resolve => {
            setTimeout(resolve, 2000);
        })
    });
}

async function getWebPImage(data: any, width = 64, height = 32) {
    const img = await WebP.Image.getEmptyImage();
    await img.initLib();
    await img.setImageData(data, {
        width,
        height,
    });
    return img;
}

async function buildFrame(img: any, options = {}) {
    return WebP.Image.generateFrame({
        img,
        ...options,
    });
}

export class Tidbyt implements INodeType {
	description: INodeTypeDescription = nodeDescription;

	static formatDevice(device: JsonObject): JsonObject {
		const json: JsonObject = {};
		Object.keys(device).forEach((key) => {
			if (device.hasOwnProperty(key) && !['tidbyt', 'installations', 'basePath'].includes(key)) {
				json[key] = device[key];
			}
		});
		return json;
	}

	static async renderPixletCode(fns: IExecuteFunctions, item: INodeExecutionData, itemIndex: number): Promise<INodeExecutionData[]> {
		const pixletCode = fns.getNodeParameter('pixletCode', itemIndex) as string;
		const dataPropertyName = fns.getNodeParameter('dataPropertyName', itemIndex) as string;
		const { field: configValues } = fns.getNodeParameter('config', itemIndex) as any;
		const frames = [];
		const { frames: frameBuffers, width = 64, height = 32, delay } =  await (global as any).pixlet.render(pixletCode, configValues || []);

		for (let i = 0; i < frameBuffers.length; i++) {
			const img = await getWebPImage(frameBuffers[i], width, height);
			const frame = await buildFrame(img, {
				delay,
			});
			frames.push(frame);
		}

		const image = await WebP.Image.save(null, {
			frames,
			width,
			height,
		});

		const binaryData = await fns.helpers.prepareBinaryData(image, 'image/webp');
		return [{ json: {}, binary: { [dataPropertyName]:binaryData } } ];
	}

	static async pushToDevice(fns: IExecuteFunctions, item: INodeExecutionData, itemIndex: number): Promise<INodeExecutionData[]> {
		const credentials: ITidbytCredentials = (await fns.getCredentials('tidbyt')) as ITidbytCredentials;
		const tidbyt = new TidbytApi(credentials.apiKey);
		const device = await tidbyt.devices.get(credentials.deviceId);
		const options = fns.getNodeParameter('options', itemIndex) as IDataObject;
		const dataPropertyName = fns.getNodeParameter('dataPropertyName', itemIndex) as string;
		const data = await fns.helpers.getBinaryDataBuffer(itemIndex, dataPropertyName);
		if (data) {
			const response = await device.push(data, {
				...options,
				installationID: options.installationId,
			});
			return [{ json: response }];
		}

		throw new NodeOperationError(fns.getNode(), `No data found for property ${dataPropertyName}`);
	}

	static async getDeviceDetails(fns: IExecuteFunctions): Promise<INodeExecutionData[]> {
		const credentials: ITidbytCredentials = (await fns.getCredentials('tidbyt')) as ITidbytCredentials;
		const tidbyt = new TidbytApi(credentials.apiKey);
		const device = await tidbyt.devices.get(credentials.deviceId);
		return [{ json: Tidbyt.formatDevice(device) }];
	}

	static async updateDeviceDetails(fns: IExecuteFunctions, item: INodeExecutionData): Promise<INodeExecutionData[]> {
		const credentials: ITidbytCredentials = (await fns.getCredentials('tidbyt')) as ITidbytCredentials;
		const tidbyt = new TidbytApi(credentials.apiKey);
		const updated = await tidbyt.devices.update(credentials.deviceId, item.json);
		return [{ json: Tidbyt.formatDevice(updated) }];
	}

	static async listInstallations(fns: IExecuteFunctions): Promise<INodeExecutionData[]> {
		const credentials: ITidbytCredentials = (await fns.getCredentials('tidbyt')) as ITidbytCredentials;
		const tidbyt = new TidbytApi(credentials.apiKey);
		const device = await tidbyt.devices.get(credentials.deviceId);
		const apps = await device.installations.list();
		const returnData: INodeExecutionData[] = apps.map((json: JsonObject) => ({ json }));
		return returnData;
	}

	static async deleteInstallation(fns: IExecuteFunctions, item: INodeExecutionData, itemIndex: number): Promise<INodeExecutionData[]> {
		const credentials: ITidbytCredentials = (await fns.getCredentials('tidbyt')) as ITidbytCredentials;
		const tidbyt = new TidbytApi(credentials.apiKey);
		const device = await tidbyt.devices.get(credentials.deviceId);
		const installationId = fns.getNodeParameter('installationId', itemIndex) as string;
		const response = await device.installations.delete(installationId);
		return [{ json: response }];
	}

	static async getAvailableApps(fns: IExecuteFunctions): Promise<INodeExecutionData[]> {
		const credentials: ITidbytCredentials = (await fns.getCredentials('tidbyt')) as ITidbytCredentials;
		const tidbyt = new TidbytApi(credentials.apiKey);
		const apps = await tidbyt.apps.list();
		const returnData: INodeExecutionData[] = apps.map((json: JsonObject) => ({ json }));
		return returnData;
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;
		const items: INodeExecutionData[] = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const pixletWasm = await fs.promises.readFile(path.join(__dirname, 'pixlet.wasm'));

		await loadPixlet(pixletWasm);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const item: INodeExecutionData = items[itemIndex];

			if (operation === 'listAvailableApps') {
				returnData.push(...await Tidbyt.getAvailableApps(this));
			} else if (operation === 'listInstallations') {
				returnData.push(...await Tidbyt.listInstallations(this));
			} else if (operation === 'deleteInstallation') {
				returnData.push(...await Tidbyt.deleteInstallation(this, item, itemIndex));
			} else if (operation === 'getDeviceDetails') {
				returnData.push(...await Tidbyt.getDeviceDetails(this));
			} else if (operation === 'updateDeviceDetails') {
				returnData.push(...await Tidbyt.updateDeviceDetails(this, item));
			} else if (operation === 'push') {
				returnData.push(...await Tidbyt.pushToDevice(this, item, itemIndex));
			} else if (operation === 'render') {
				returnData.push(...await Tidbyt.renderPixletCode(this, item, itemIndex));
			} else {
				throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported!`);
			}
		}

		return this.prepareOutputData(returnData);
	}
}
