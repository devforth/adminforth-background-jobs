<template>
  <div class="w-1vw md:w-64 bg-white border border-gray-200 rounded-md">
    <Modal v-for="job in props.jobs" :key="job.id" :beforeOpenFunction="props.closeDropdown">
      <template #trigger>
        <div class="flex items-center w-full px-4 py-3 border-b border-gray-200 hover:bg-gray-50 transition-colors">
          <div class="flex flex-col w-full max-w-48">
            <p class="flex gap-2 items-end justify-between text-nowrap">
              <span class="text-sm h-full text truncate">{{ job.name }}</span> 
              <span class="text-xs text-gray-600">{{ getTimeAgoString(new Date(job.createdAt)) }}</span> 
            </p>
            <ProgressBar 
              class="mt-1"
              :current-value="job.progress" 
              :max-value="100" 
              :min-value="0"
              :showAnimation="job.status === 'IN_PROGRESS'"
              :showLabels="false"
              :showValues="false"
              :show-progress="false"
            />
          </div>
          <StateToIcon :job="job" />
        </div>
      </template>
      <div>
        <JobInfoPopup :job="job" />
      </div>
    </Modal>

  </div>
</template>


<script setup lang="ts">
import type { IJob } from './utils';
import { getTimeAgoString } from '@/utils';
import { ProgressBar, Modal } from '@/afcl';
import { useI18n } from 'vue-i18n';
import JobInfoPopup from './JobInfoPopup.vue';
import StateToIcon from './StateToIcon.vue';

const { t } = useI18n();

const props = defineProps<{
  jobs: IJob[];
  closeDropdown: () => void;
}>();

  
</script>