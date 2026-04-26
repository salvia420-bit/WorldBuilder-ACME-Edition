#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aColor;

uniform mat4 uViewProjection;
uniform mat4 uModel;

out vec3 vColor;

void main() {
    gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
    vColor = aColor;
}
