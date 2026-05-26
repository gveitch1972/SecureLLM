import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  ec2Sg: ec2.SecurityGroup;
  modelBucket: s3.Bucket;
  publicSubnetId: string;
}

export class ComputeStack extends cdk.Stack {
  public readonly launchTemplateName = 'secure-llm';

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    props.modelBucket.grantReadWrite(role, 'secure-llm/*');

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:eu-west-2:${this.account}:parameter/secure-llm/*`],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: ['*'],
      conditions: { StringEquals: { 'ec2:ResourceTag/Name': 'secure-llm' } },
    }));

    // DLAMI: NVIDIA driver, Docker, nvidia-container-toolkit pre-installed
    // GPU path: use DLAMI + Docker with --gpus all
    // CPU path (t3.large smoke test): standard AL2023 + Ollama binary (no Docker needed)
    const ami = ec2.MachineImage.latestAmazonLinux2023();

    const script = `#!/bin/bash
set -euo pipefail
MODEL_BUCKET="${props.modelBucket.bucketName}"
REGION="eu-west-2"
LOG=/var/log/secure-llm.log
exec >> $LOG 2>&1

echo "=== Boot $(date) ==="
export HOME=/root

# Install Ollama binary (CPU mode — no Docker/GPU needed)
curl -fsSL https://ollama.com/install.sh | sh

# Pull model cache from S3 (no-op on first run, fast on subsequent)
mkdir -p /root/.ollama/models
aws s3 sync "s3://$MODEL_BUCKET/secure-llm/ollama/" /root/.ollama/models/ --region $REGION --quiet || true

# Start Ollama
OLLAMA_HOST=0.0.0.0:11434 nohup ollama serve >> $LOG 2>&1 &
until curl -sf http://localhost:11434/api/tags > /dev/null; do sleep 3; done
echo "Ollama ready"

# llama3.2:1b for CPU demo (fits API GW 29s timeout). Switch to llama3:8b on GPU.
if ! ollama list | grep -q "llama3.2:1b"; then
  ollama pull llama3.2:1b
fi

# Warm S3 cache for next boot
aws s3 sync /root/.ollama/models/ "s3://$MODEL_BUCKET/secure-llm/ollama/" --region $REGION --quiet || true

# Install FastAPI gateway
dnf install -y python3-pip
pip3 install fastapi uvicorn httpx

mkdir -p /opt/secure-llm
cat > /opt/secure-llm/main.py << 'PYEOF'
import os, uuid, asyncio, time, subprocess, urllib.request
import httpx
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
API_KEY = os.getenv("API_KEY", "")
IDLE_TIMEOUT = int(os.getenv("IDLE_TIMEOUT_SECS", "120"))

app = FastAPI(title="Secure LLM Gateway")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

jobs = {}
last_activity = time.time()

@app.middleware("http")
async def track_activity(request: Request, call_next):
    global last_activity
    last_activity = time.time()
    return await call_next(request)

def check_key(key):
    if API_KEY and key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    model: str = "llama3.2:1b"
    messages: List[Message]

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/models")
async def models(x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{OLLAMA_URL}/api/tags")
        return r.json()

async def run_inference(job_id, req):
    try:
        async with httpx.AsyncClient(timeout=300.0) as c:
            r = await c.post(f"{OLLAMA_URL}/api/chat", json={
                "model": req.model,
                "messages": [m.model_dump() for m in req.messages],
                "stream": False,
            })
            r.raise_for_status()
            jobs[job_id] = {"status": "done", "result": r.json()}
    except Exception as e:
        jobs[job_id] = {"status": "error", "error": str(e)}

@app.post("/chat")
async def chat(req: ChatRequest, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending"}
    asyncio.create_task(run_inference(job_id, req))
    return {"jobId": job_id}

@app.get("/result/{job_id}")
async def result(job_id: str, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    return jobs.get(job_id, {"status": "not_found"})

async def idle_watchdog():
    await asyncio.sleep(30)
    while True:
        await asyncio.sleep(10)
        if time.time() - last_activity > IDLE_TIMEOUT:
            try:
                token_req = urllib.request.Request(
                    "http://169.254.169.254/latest/api/token",
                    headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
                    method="PUT",
                )
                token = urllib.request.urlopen(token_req, timeout=2).read().decode()
                iid_req = urllib.request.Request(
                    "http://169.254.169.254/latest/meta-data/instance-id",
                    headers={"X-aws-ec2-metadata-token": token},
                )
                instance_id = urllib.request.urlopen(iid_req, timeout=2).read().decode()
                subprocess.Popen(["aws", "ec2", "terminate-instances",
                                  "--instance-ids", instance_id, "--region", "eu-west-2"])
            except Exception:
                pass

@app.on_event("startup")
async def startup():
    asyncio.create_task(idle_watchdog())
PYEOF

API_KEY=$(aws ssm get-parameter --name /secure-llm/api-key --with-decryption --query Parameter.Value --output text --region $REGION 2>/dev/null || echo "")
echo "API_KEY=$API_KEY" > /etc/secure-llm.env
chmod 600 /etc/secure-llm.env

printf '[Unit]\\nDescription=Secure LLM FastAPI\\nAfter=network.target\\n\\n[Service]\\nWorkingDirectory=/opt/secure-llm\\nEnvironmentFile=/etc/secure-llm.env\\nExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000\\nRestart=always\\nRestartSec=3\\n\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/fastapi.service

systemctl daemon-reload
systemctl enable --now fastapi
echo "=== Gateway ready ==="
`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(script);

    // No securityGroup here — it goes in NetworkInterfaces so subnet + SG are co-located
    const lt = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: this.launchTemplateName,
      // TODO: switch back to G4DN.XLARGE once GPU quota L-DB2E81BA approved
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
      machineImage: ami,
      role,
      userData,
    });

    const cfnLt = lt.node.defaultChild as ec2.CfnLaunchTemplate;

    // 20GB root volume — default 8GB is too small for Ollama binary + llama3:8b (4.7GB)
    cfnLt.addPropertyOverride('LaunchTemplateData.BlockDeviceMappings', [{
      DeviceName: '/dev/xvda',
      Ebs: { VolumeSize: 20, VolumeType: 'gp3', DeleteOnTermination: true },
    }]);

    // Terminate (not stop) on shutdown so idle watchdog fully cleans up the instance
    cfnLt.addPropertyOverride('LaunchTemplateData.InstanceInitiatedShutdownBehavior', 'terminate');

    // Tag instances so ec2:TerminateInstances IAM condition matches
    cfnLt.addPropertyOverride('LaunchTemplateData.TagSpecifications', [{
      ResourceType: 'instance',
      Tags: [{ Key: 'Name', Value: 'secure-llm' }],
    }]);

    // Bake subnet + SG into the template so RunInstances needs no network params
    cfnLt.addPropertyOverride('LaunchTemplateData.NetworkInterfaces', [{
      DeviceIndex: 0,
      SubnetId: props.publicSubnetId,
      Groups: [props.ec2Sg.securityGroupId],
      AssociatePublicIpAddress: true,
    }]);

    // TODO: switch back to Spot once quota L-3819A6DF is approved (currently 0 vCPUs)
    // cfnLt.addPropertyOverride('LaunchTemplateData.InstanceMarketOptions', {
    //   MarketType: 'spot',
    //   SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' },
    // });

    new cdk.CfnOutput(this, 'LaunchTemplateName', { value: this.launchTemplateName });
  }
}
