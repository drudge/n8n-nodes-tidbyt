import {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class Tidbyt implements ICredentialType {
	name = 'tidbyt';
	displayName = 'Tidbyt API';
	documentationUrl = 'tidbyt';
	properties: INodeProperties[] = [
		{
			displayName: 'Device ID',
			name: 'deviceId',
			type: 'string',
			default: '',
			required: true,
			description: 'Device ID available under the Get API key button on the General tab in the mobile app',
		},
		{
			displayName: 'Key',
			name: 'apiKey',
			type: 'string',
			default: '',
			required: true,
			description: 'API Key ID available under the Get API key button on the General tab in the mobile app',
		},
	];
}
