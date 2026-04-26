#version 300 es
precision highp float;

in vec3 vColor;

uniform float uAlpha;
uniform float uBrightness;

out vec4 FragColor;

void main() {
    FragColor = vec4(vColor * uBrightness, uAlpha);
}
