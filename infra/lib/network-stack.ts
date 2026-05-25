import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly ec2Sg: ec2.SecurityGroup;
  public readonly lambdaSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      // One public subnet — EC2 gets outbound internet for Ollama pull.
      // SG blocks all inbound except Lambda. For enterprise: add private subnet + NAT GW.
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
      // S3 gateway endpoint: model cache reads never leave AWS network
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    // Lambda SG — placed in VPC to reach EC2 private IP
    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'secure-llm proxy lambda',
      allowAllOutbound: false,
    });

    // EC2 SG — inbound on :8000 from Lambda only, outbound HTTPS for model pull
    this.ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc: this.vpc,
      description: 'secure-llm inference instance',
      allowAllOutbound: false,
    });

    this.lambdaSg.addEgressRule(this.ec2Sg, ec2.Port.tcp(8000), 'FastAPI');
    this.ec2Sg.addIngressRule(this.lambdaSg, ec2.Port.tcp(8000), 'FastAPI from Lambda');
    this.ec2Sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Ollama registry + AWS APIs');
    this.ec2Sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(11434), 'Ollama internal');

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
