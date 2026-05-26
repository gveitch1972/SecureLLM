import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface GatewayStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  launchTemplateName: string;
}

const ORCHESTRATOR_CODE = `
const { EC2Client, RunInstancesCommand, DescribeInstancesCommand, TerminateInstancesCommand } = require('@aws-sdk/client-ec2');
const client = new EC2Client({ region: 'eu-west-2' });
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,x-api-key' };
const TAG = 'secure-llm';

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;

  const getRunning = async () => {
    const res = await client.send(new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:Name', Values: [TAG] },
        { Name: 'instance-state-name', Values: ['pending', 'running'] },
      ],
    }));
    return res.Reservations.flatMap(r => r.Instances);
  };

  if (method === 'POST' && path === '/session') {
    const existing = await getRunning();
    if (existing.length > 0) {
      const i = existing[0];
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: i.State.Name, instanceId: i.InstanceId, privateIp: i.PrivateIpAddress }) };
    }
    try {
      const result = await client.send(new RunInstancesCommand({
        MinCount: 1, MaxCount: 1,
        LaunchTemplate: { LaunchTemplateName: process.env.LAUNCH_TEMPLATE_NAME, Version: '$Latest' },
        TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: TAG }] }],
      }));
      const i = result.Instances[0];
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'starting', instanceId: i.InstanceId, privateIp: i.PrivateIpAddress }) };
    } catch (err) {
      const code = err.Code || err.name || 'LaunchFailed';
      return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: err.message, code }) };
    }
  }

  if (method === 'GET' && path === '/session') {
    const instances = await getRunning();
    if (instances.length === 0) return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'stopped' }) };
    const i = instances[0];
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: i.State.Name, instanceId: i.InstanceId, privateIp: i.PrivateIpAddress }) };
  }

  if (method === 'DELETE' && path === '/session') {
    const instances = await getRunning();
    const ids = instances.map(i => i.InstanceId);
    if (ids.length > 0) await client.send(new TerminateInstancesCommand({ InstanceIds: ids }));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ terminated: ids }) };
  }

  return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not found' }) };
};
`;

const PROXY_CODE = `
const http = require('http');
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,x-api-key,x-private-ip' };
const FASTAPI_KEY = process.env.FASTAPI_KEY || '';

function call(method, privateIp, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: privateIp, port: 8000, path,
      method, headers: { 'Content-Type': 'application/json', 'x-api-key': FASTAPI_KEY },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  const hdrs = event.headers || {};
  const privateIp = hdrs['x-private-ip'];
  if (!privateIp) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'x-private-ip header required' }) };

  const path = event.resource;
  const method = event.httpMethod;

  try {
    if (method === 'GET' && (path === '/health' || path === '/models')) {
      const res = await call('GET', privateIp, path === '/health' ? '/health' : '/models', null);
      return { statusCode: res.statusCode, headers: CORS, body: res.body };
    }
    if (method === 'POST' && path === '/chat') {
      const res = await call('POST', privateIp, '/chat', JSON.parse(event.body || '{}'));
      return { statusCode: res.statusCode, headers: CORS, body: res.body };
    }
    if (method === 'GET' && path === '/result/{jobId}') {
      const jobId = (event.pathParameters || {}).jobId;
      const res = await call('GET', privateIp, '/result/' + jobId, null);
      return { statusCode: res.statusCode, headers: CORS, body: res.body };
    }
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not found' }) };
  } catch (err) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
`;

export class GatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // Orchestrator: NOT in VPC — needs to call EC2/IAM AWS APIs directly
    const orchestratorFn = new lambda.Function(this, 'OrchestratorFn', {
      functionName: 'secure-llm-orchestrator',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(ORCHESTRATOR_CODE),
      environment: { LAUNCH_TEMPLATE_NAME: props.launchTemplateName },
    });

    orchestratorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ec2:RunInstances', 'ec2:TerminateInstances', 'ec2:CreateTags', 'iam:PassRole'],
      resources: ['*'],
    }));

    // Proxy: IN VPC — reaches EC2 private IP on :8000
    const fastapiKey = ssm.StringParameter.valueFromLookup(this, '/secure-llm/api-key');
    const proxyFn = new lambda.Function(this, 'ProxyFn', {
      functionName: 'secure-llm-proxy',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(130),
      code: lambda.Code.fromInline(PROXY_CODE),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true,
      securityGroups: [props.lambdaSg],
      environment: { FASTAPI_KEY: fastapiKey },
    });

    // API Gateway with API key auth
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'secure-llm-api',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'x-api-key', 'x-private-ip'],
      },
    });

    // Free tier: shared key baked into frontend bundle — quota limits anonymous abuse
    const plan = api.addUsagePlan('UsagePlan', {
      name: 'secure-llm-free',
      quota: { limit: 50, period: apigateway.Period.DAY },
      throttle: { rateLimit: 2, burstLimit: 5 },
    });
    const apiKey = api.addApiKey('ApiKey', { apiKeyName: 'secure-llm-key' });
    plan.addApiKey(apiKey);
    plan.addApiStage({ api, stage: api.deploymentStage });

    // Named tier: individual keys Graham generates for trusted users
    const namedPlan = api.addUsagePlan('NamedPlan', {
      name: 'secure-llm-named',
      quota: { limit: 200, period: apigateway.Period.DAY },
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    namedPlan.addApiStage({ api, stage: api.deploymentStage });

    new cdk.CfnOutput(this, 'NamedPlanId', { value: namedPlan.usagePlanId, description: 'Add new keys: aws apigateway create-api-key --name <user> --enabled && aws apigateway create-usage-plan-key --usage-plan-id <id> --key-id <key-id> --key-type API_KEY' });

    const keyRequired = { apiKeyRequired: true };
    const orchestratorInt = new apigateway.LambdaIntegration(orchestratorFn);
    const proxyInt = new apigateway.LambdaIntegration(proxyFn);

    const session = api.root.addResource('session');
    session.addMethod('POST', orchestratorInt, keyRequired);
    session.addMethod('GET', orchestratorInt, keyRequired);
    session.addMethod('DELETE', orchestratorInt, keyRequired);

    const health = api.root.addResource('health');
    health.addMethod('GET', proxyInt, keyRequired);

    const models = api.root.addResource('models');
    models.addMethod('GET', proxyInt, keyRequired);

    const chat = api.root.addResource('chat');
    chat.addMethod('POST', proxyInt, keyRequired);

    const result = api.root.addResource('result');
    const resultJob = result.addResource('{jobId}');
    resultJob.addMethod('GET', proxyInt, keyRequired);

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId, description: 'Retrieve value: aws apigateway get-api-key --api-key <id> --include-value' });
  }
}
