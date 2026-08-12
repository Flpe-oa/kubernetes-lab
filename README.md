# 🚀 Kubernetes Lab Local — Simulando Produção no Windows

> Stack completa de Kubernetes rodando localmente no Windows via WSL2.  
> Inclui load balancer, proxy reverso, TLS, múltiplos serviços e observabilidade completa.

---

## 📋 Índice

- [Visão Geral](#visão-geral)
- [Pré-requisitos](#pré-requisitos)
- [Estrutura de Pastas](#estrutura-de-pastas)
- [Stack Instalada](#stack-instalada)
- [Passo a Passo](#passo-a-passo)
  - [1. Preparar o ambiente WSL2](#1-preparar-o-ambiente-wsl2)
  - [2. Criar o cluster Kind](#2-criar-o-cluster-kind)
  - [3. MetalLB — Load Balancer](#3-metallb--load-balancer)
  - [4. Nginx Ingress Controller](#4-nginx-ingress-controller)
  - [5. cert-manager — TLS](#5-cert-manager--tls)
  - [6. Frontend — Nginx](#6-frontend--nginx)
  - [7. API — Node.js / Express](#7-api--nodejs--express)
  - [8. Monitoramento — Grafana + Prometheus + Loki + Alloy](#8-monitoramento--grafana--prometheus--loki--alloy)
  - [9. Configurar /etc/hosts](#9-configurar-etchosts)
  - [10. Acessar pelo navegador Windows](#10-acessar-pelo-navegador-windows)
- [Fluxo de uma Requisição](#fluxo-de-uma-requisição)
- [URLs do Lab](#urls-do-lab)
- [Comandos Úteis](#comandos-úteis)
- [Diferenças para Produção Real](#diferenças-para-produção-real)

---

## Visão Geral

Este lab simula um ambiente Kubernetes de produção completo rodando localmente. O objetivo é aprender os componentes reais usados em empresas sem precisar de nuvem ou custos.

```
Navegador Windows
      ↓
port-forward (ponte WSL2 → Windows)
      ↓
MetalLB: 172.18.0.200  ← simula Load Balancer de nuvem
      ↓
Nginx Ingress Controller  ← proxy reverso central
      ↓
      ├── meuapp.local         → Frontend (3 pods nginx)
      ├── api.meuapp.local     → API Node.js (2 pods)
      └── grafana.meuapp.local → Grafana (monitoramento)
```

---

## Pré-requisitos

- Windows 10/11 com WSL2 habilitado
- Ubuntu 22.04 via WSL2
- Docker Desktop com integração WSL2 ativada

### Instalar WSL2

```powershell
# PowerShell como Administrador
wsl --install
wsl --set-default-version 2
# Instalar Ubuntu 22.04 pela Microsoft Store
```

### Instalar ferramentas no WSL

```bash
# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Kind
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.23.0/kind-linux-amd64
chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind

# Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

---

## Estrutura de Pastas

```
kindproject/
├── cluster/
│   ├── kind-config.yaml        # topologia do cluster (1 control-plane + 2 workers)
│   ├── metallb-pool.yaml       # range de IPs do load balancer
│   └── issuer.yaml             # autoridade certificadora TLS (self-signed)
├── frontend/
│   ├── deployment.yaml         # 3 réplicas do Nginx
│   ├── service.yaml            # ClusterIP expondo porta 80
│   └── ingress.yaml            # roteamento: meuapp.local → frontend
├── api/
│   ├── src/
│   │   └── index.js            # código da API Node.js/Express
│   ├── Dockerfile              # receita da imagem Docker
│   ├── package.json            # dependências (Express)
│   ├── deployment.yaml         # 2 réplicas com liveness/readiness probes
│   ├── service.yaml            # ClusterIP porta 80 → pod porta 3000
│   └── ingress.yaml            # roteamento: api.meuapp.local → api
└── monitoring/
    └── ingress.yaml            # roteamento: grafana.meuapp.local → Grafana
```

> **Por que um Ingress por serviço?**  
> Cada serviço gerencia seu próprio Ingress de forma independente — padrão usado em empresas onde times diferentes cuidam de serviços diferentes.

---

## Stack Instalada

| Componente | Função | Instalação |
|---|---|---|
| Kind | Cluster Kubernetes local | CLI |
| MetalLB | Simula Load Balancer de nuvem | kubectl apply |
| Nginx Ingress | Proxy reverso e roteamento | Helm |
| cert-manager | Certificados TLS automáticos | Helm |
| Prometheus | Coleta métricas dos pods | Helm (kube-prometheus-stack) |
| Grafana | Dashboards de monitoramento | Helm (kube-prometheus-stack) |
| Loki | Armazenamento de logs | Helm |
| Alloy | Coleta logs de todos os pods | Helm |

---

## Passo a Passo

### 1. Preparar o ambiente WSL2

```bash
mkdir -p ~/kindproject/{cluster,frontend,api/src,monitoring}
cd ~/kindproject
```

---

### 2. Criar o cluster Kind

**`cluster/kind-config.yaml`**
```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
```

```bash
kind create cluster --config cluster/kind-config.yaml --name lab

# Verificar
kubectl get nodes
```

---

### 3. MetalLB — Load Balancer

Sem o MetalLB, Services do tipo `LoadBalancer` ficam com `EXTERNAL-IP: <pending>` para sempre.

```bash
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.5/config/manifests/metallb-native.yaml

kubectl wait --namespace metallb-system \
  --for=condition=ready pod \
  --selector=app=metallb \
  --timeout=120s
```

**`cluster/metallb-pool.yaml`**
```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: local-pool
  namespace: metallb-system
spec:
  addresses:
    - 172.18.0.200-172.18.0.220
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: local-advert
  namespace: metallb-system
```

```bash
kubectl apply -f cluster/metallb-pool.yaml
```

---

### 4. Nginx Ingress Controller

Recebe todo o tráfego no IP do MetalLB e roteia para o serviço correto baseado no domínio.

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace

kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s

# Verificar IP externo (deve mostrar 172.18.0.200)
kubectl get svc -n ingress-nginx
```

---

### 5. cert-manager — TLS

Automatiza criação e renovação de certificados TLS. No lab usamos self-signed; em produção seria Let's Encrypt.

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true

kubectl wait --namespace cert-manager \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/instance=cert-manager \
  --timeout=120s
```

**`cluster/issuer.yaml`**
```yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: selfsigned-issuer
  namespace: default
spec:
  selfSigned: {}
```

```bash
kubectl apply -f cluster/issuer.yaml
```

---

### 6. Frontend — Nginx

**`frontend/deployment.yaml`**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: nginx:alpine
          ports:
            - containerPort: 80
```

**`frontend/service.yaml`**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: frontend
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
```

**`frontend/ingress.yaml`**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  annotations:
    cert-manager.io/issuer: "selfsigned-issuer"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - meuapp.local
      secretName: meuapp-tls
  rules:
    - host: meuapp.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: 80
```

```bash
kubectl apply -f frontend/deployment.yaml
kubectl apply -f frontend/service.yaml
kubectl apply -f frontend/ingress.yaml
```

---

### 7. API — Node.js / Express

**`api/src/index.js`**
```javascript
const express = require('express')
const os = require('os')
const app = express()

app.use(express.json())

app.get('/', (req, res) => {
  res.json({
    message: 'API funcionando!',
    pod: os.hostname(),      // mostra qual pod respondeu
    timestamp: new Date()
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' }) // usado pelo Kubernetes para health checks
})

app.get('/users', (req, res) => {
  res.json({
    users: [
      { id: 1, name: 'Felipe', role: 'admin' },
      { id: 2, name: 'João',   role: 'dev'   },
    ],
    served_by: os.hostname()
  })
})

app.listen(3000, () => console.log('API rodando na porta 3000'))
```

**`api/package.json`**
```json
{
  "name": "api",
  "version": "1.0.0",
  "main": "src/index.js",
  "dependencies": {
    "express": "^4.18.2"
  }
}
```

**`api/Dockerfile`**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY src/ src/
EXPOSE 3000
CMD ["node", "src/index.js"]
```

```bash
# Build e carregar no cluster (sem registry externo)
cd api
docker build -t minha-api:v1 .
kind load docker-image minha-api:v1 --name lab
cd ..
```

**`api/deployment.yaml`**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: minha-api:v1
          imagePullPolicy: Never      # usa imagem local do Kind
          ports:
            - containerPort: 3000
          livenessProbe:              # reinicia o pod se travar
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:             # retira do balanceamento se não estiver pronto
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 3
            periodSeconds: 5
```

**`api/service.yaml`**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector:
    app: api
  ports:
    - port: 80           # porta exposta pelo Service
      targetPort: 3000   # porta real do container
```

**`api/ingress.yaml`**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  annotations:
    cert-manager.io/issuer: "selfsigned-issuer"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.meuapp.local
      secretName: api-tls
  rules:
    - host: api.meuapp.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 80
```

```bash
kubectl apply -f api/deployment.yaml
kubectl apply -f api/service.yaml
kubectl apply -f api/ingress.yaml
```

---

### 8. Monitoramento — Grafana + Prometheus + Loki + Alloy

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

**Instalar kube-prometheus-stack** (Grafana + Prometheus + kube-state-metrics + node-exporter):

```bash
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set grafana.adminPassword=admin123 \
  --set grafana.env.GF_SERVER_ROOT_URL="http://grafana.meuapp.local" \
  --set grafana.env.GF_SERVER_SERVE_FROM_SUB_PATH="false"
```

**Instalar Loki:**

```bash
helm install loki grafana/loki \
  --namespace monitoring \
  --set deploymentMode=SingleBinary \
  --set loki.auth_enabled=false \
  --set loki.commonConfig.replication_factor=1 \
  --set loki.storage.type=filesystem \
  --set loki.useTestSchema=true \
  --set singleBinary.replicas=1 \
  --set read.replicas=0 \
  --set write.replicas=0 \
  --set backend.replicas=0 \
  --set chunksCache.enabled=false \
  --set resultsCache.enabled=false
```

**Instalar Alloy** (substituto oficial do Promtail — coleta logs de todos os pods):

```bash
helm install alloy grafana/alloy \
  --namespace monitoring \
  --set alloy.configMap.content='
logging {
  level = "info"
}

discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pods.output
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push"
  }
}
'
```

**`monitoring/ingress.yaml`**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grafana-ingress
  namespace: monitoring
spec:
  ingressClassName: nginx
  rules:
    - host: grafana.meuapp.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: monitoring-grafana
                port:
                  number: 80
```

```bash
kubectl apply -f monitoring/ingress.yaml
```

**Configurar datasources no Grafana** (`http://grafana.meuapp.local:8080` → admin / admin123):

| Datasource | URL |
|---|---|
| Prometheus | `http://monitoring-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090` |
| Loki | `http://loki-gateway.monitoring.svc.cluster.local` |

> Dashboard recomendado: importe o ID **15760** para visualização completa do cluster.

---

### 9. Configurar /etc/hosts

**No WSL:**
```bash
echo "172.18.0.200  meuapp.local" | sudo tee -a /etc/hosts
echo "172.18.0.200  api.meuapp.local" | sudo tee -a /etc/hosts
echo "172.18.0.200  grafana.meuapp.local" | sudo tee -a /etc/hosts
```

**No Windows** — edite `C:\Windows\System32\drivers\etc\hosts` como Administrador:
```
127.0.0.1  meuapp.local
127.0.0.1  api.meuapp.local
127.0.0.1  grafana.meuapp.local
```

---

### 10. Acessar pelo navegador Windows

O IP `172.18.0.200` é interno ao WSL2. Usamos port-forward como ponte — deixe rodando em um terminal dedicado:

```bash
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller \
  8080:80 8443:443 --address 0.0.0.0
```

---

## URLs do Lab

| Serviço | HTTP | HTTPS |
|---|---|---|
| Frontend | http://meuapp.local:8080 | https://meuapp.local:8443 |
| API | http://api.meuapp.local:8080 | https://api.meuapp.local:8443 |
| API /users | http://api.meuapp.local:8080/users | — |
| Grafana | http://grafana.meuapp.local:8080 | — |

> O aviso de certificado no HTTPS é esperado com self-signed. Em produção com Let's Encrypt não ocorre.

---

## Fluxo de uma Requisição

```
curl http://api.meuapp.local:8080/users
          ↓
   port-forward :8080
          ↓
   Nginx Ingress (172.18.0.200:80)
          ↓
   Ingress Rule: api.meuapp.local → Service: api
          ↓
   Service: api (ClusterIP :80 → pod :3000)
          ↓
   Load balancing entre pod 1 e pod 2
          ↓
   Node.js responde GET /users
          ↓
   JSON { users: [...], served_by: "api-xxx" }
```

---

## Comandos Úteis

```bash
# Ver tudo rodando
kubectl get pods -A
kubectl get ingress -A
kubectl get certificate

# Acompanhar pods em tempo real
kubectl get pods -w

# Ver logs de um pod
kubectl logs <nome-do-pod>
kubectl logs <nome-do-pod> -f   # tempo real

# Entrar dentro de um container
kubectl exec -it <nome-do-pod> -- /bin/sh

# Escalar manualmente
kubectl scale deployment frontend --replicas=5

# Testar load balancing (vê os pods alternando)
for i in {1..6}; do
  curl -s http://api.meuapp.local:8080/ | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(f'Request $i → pod: {d[\"pod\"]}')"
done

# Helm — listar releases instalados
helm list -A

# Recriar o cluster do zero
kind delete cluster --name lab
kind create cluster --config cluster/kind-config.yaml --name lab
```

---

## Diferenças para Produção Real

| Componente | Lab local | Produção (AWS/GCP) |
|---|---|---|
| Cluster | Kind | EKS / GKE / AKS |
| Load Balancer | MetalLB | AWS ELB (automático) |
| Ingress | Nginx Ingress | Nginx Ingress (igual) |
| Certificado | self-signed | Let's Encrypt via cert-manager |
| Domínio | *.meuapp.local | *.suaempresa.com |
| Port-forward | Necessário | Não existe — IP público direto |
| Registry | kind load | ECR / Docker Hub / GCR |

> Os YAMLs de Deployment, Service e Ingress são **idênticos** entre o lab e produção.  
> O que muda é apenas onde o cluster roda e quem provisiona o Load Balancer.

---

*Kubernetes Lab Local — Felipe 2026*
