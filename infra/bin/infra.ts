#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';
import { ComputeStack } from '../lib/compute-stack';
import { GatewayStack } from '../lib/gateway-stack';
import { HostingStack } from '../lib/hosting-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-2' };

const network = new NetworkStack(app, 'SecureLlmNetworkStack', { env });
const storage = new StorageStack(app, 'SecureLlmStorageStack', { env });

const compute = new ComputeStack(app, 'SecureLlmComputeStack', {
  env,
  vpc: network.vpc,
  ec2Sg: network.ec2Sg,
  modelBucket: storage.modelBucket,
});

new GatewayStack(app, 'SecureLlmGatewayStack', {
  env,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  launchTemplateName: compute.launchTemplateName,
});

// CloudFront cert must be in us-east-1
new HostingStack(app, 'SecureLlmHostingStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});
