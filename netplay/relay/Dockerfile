FROM golang:1.26.0 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /relay .

FROM scratch
COPY --from=build /relay /relay
USER 65532:65532
ENV RELAY_ADDR=:8443
EXPOSE 8443/tcp 8443/udp
ENTRYPOINT ["/relay"]
